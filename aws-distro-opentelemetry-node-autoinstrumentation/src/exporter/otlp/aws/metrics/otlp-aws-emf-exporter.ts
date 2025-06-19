// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry EMF (Embedded Metric Format) Exporter for CloudWatch.
 * This exporter converts OTel metrics into CloudWatch EMF format.
 */
import { Attributes, diag, HrTime } from '@opentelemetry/api';
import { CloudWatchLogsClientConfig, PutLogEventsCommandInput, CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import {
  Aggregation,
  AggregationTemporality,
  DataPoint,
  DataPointType,
  ExponentialHistogram,
  ExponentialHistogramMetricData,
  GaugeMetricData,
  Histogram,
  HistogramMetricData,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
  SumMetricData,
} from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import * as Crypto from 'crypto';

// Constants for CloudWatch Logs limits
export const CW_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 256KB
export const CW_MAX_REQUEST_EVENT_COUNT = 10000;
export const CW_PER_EVENT_HEADER_BYTES = 26;
export const BATCH_FLUSH_INTERVAL = 60 * 1000;
export const CW_MAX_REQUEST_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB
export const CW_TRUNCATED_SUFFIX = '[Truncated...]';
export const CW_EVENT_TIMESTAMP_LIMIT_PAST = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
export const CW_EVENT_TIMESTAMP_LIMIT_FUTURE = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

export const RECORD_DATA_TYPES = {
  SUM_DATA: 'SUM_DATA',
  HISTOGRAM_DATA: 'HISTOGRAM_DATA',
  EXP_HISTOGRAM_DATA: 'EXP_HISTOGRAM_DATA',
};

export interface MetricRecord {
  name: string;
  unit: string;
  description: string;
  timestamp: number;
  attributes: Attributes;

  // Only one of the following should be defined
  sumData?: number;
  histogramData?: HistogramMetricRecordData;
  expHistogramData?: ExponentialHistogramMetricRecordData;
  value?: number;
}

export interface HistogramMetricRecordData {
  Count: number;
  Sum: number;
  Max: number;
  Min: number;
}

export interface ExponentialHistogramMetricRecordData {
  Values: number[];
  Counts: number[];
  Count: number;
  Sum: number;
  Max: number;
  Min: number;
}

interface EMFLog {
  _aws: _Aws;
  [key: `otel.resource.${string}`]: string;
  [metricName: string]: any; // Can be any, but usually will be used for Metric Record Data
  Version: string;
}

export interface _Aws {
  CloudWatchMetrics: CloudWatchMetric[];
  Timestamp: number;
}

export interface CloudWatchMetric {
  Namespace: string;
  Dimensions: string[][];
  Metrics: Metric[];
}

export interface Metric {
  Name: string;
  Unit?: string;
}

export interface LogEvent {
  message: string;
  timestamp: number;
}

export interface EventBatch {
  logEvents: LogEvent[];
  byteTotal: number;
  minTimestampMs: number;
  maxTimestampMs: number;
  createdTimestampMs: number;
}

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format.
 *
 * This exporter converts OTel metrics into CloudWatch EMF logs which are then
 * sent to CloudWatch Logs. CloudWatch Logs automatically extracts the metrics
 * from the EMF logs.
 */
export class CloudWatchEMFExporter implements PushMetricExporter {
  private namespace: string;
  private logGroupName: string | undefined;
  private logStreamName: string;
  private aggregationTemporality: AggregationTemporality;

  private logsClient: CloudWatchLogs;
  private logStreamExists: boolean;
  private logStreamExistsPromise: Promise<void>;
  // Event batch to store logs before sending to CloudWatch
  private eventBatch: undefined | EventBatch = undefined;

  private EMF_SUPPORTED_UNITS: Set<string> = new Set<string>([
    'Seconds',
    'Microseconds',
    'Milliseconds',
    'Bytes',
    'Kilobytes',
    'Megabytes',
    'Gigabytes',
    'Terabytes',
    'Bits',
    'Kilobits',
    'Megabits',
    'Gigabits',
    'Terabits',
    'Percent',
    'Count',
    'Bytes/Second',
    'Kilobytes/Second',
    'Megabytes/Second',
    'Gigabytes/Second',
    'Terabytes/Second',
    'Bits/Second',
    'Kilobits/Second',
    'Megabits/Second',
    'Gigabits/Second',
    'Terabits/Second',
    'Count/Second',
    'None',
  ]);

  // OTel to CloudWatch unit mapping
  private UNIT_MAPPING: Map<string, string> = new Map<string, string>(
    Object.entries({
      '1': '',
      ns: '',
      ms: 'Milliseconds',
      s: 'Seconds',
      us: 'Microseconds',
      By: 'Bytes',
      bit: 'Bits',
    })
  );

  /**
   * Initialize the CloudWatch EMF exporter.
   *
   * @param namespace CloudWatch namespace for metrics
   * @param logGroupName CloudWatch log group name
   * @param logStreamName CloudWatch log stream name (auto-generated if None)
   * @param AggregationTemporality Optional AggregationTemporality to indicate the way additive quantities are expressed
   * @param cloudwatchLogsConfig CloudWatch Logs Client Configuration. Configure region here if needed explicitly.
   */
  constructor(
    namespace: string = 'default',
    logGroupName: string | undefined,
    logStreamName: string | undefined,
    aggregationTemporality: AggregationTemporality = AggregationTemporality.DELTA,
    cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}
  ) {
    this.namespace = namespace;
    this.logGroupName = logGroupName;
    this.logStreamName = logStreamName || this.generateLogStreamName();
    this.aggregationTemporality = aggregationTemporality;

    this.logsClient = new CloudWatchLogs(cloudwatchLogsConfig); //[] aws region?

    // Determine that Log group/stream exists asynchronously. The Constructor cannot wait on async
    // operations, so whether or not the group/stream actually exists will be determined later.
    this.logStreamExists = false;
    this.logStreamExistsPromise = this.ensureLogGroupExists().then(async () => {
      await this.ensureLogStreamExists();
    });
  }

  /**
   * Generate a unique log stream name.
   *
   * @returns {string}
   */
  private generateLogStreamName(): string {
    const uniqueId = Crypto.randomUUID().substring(0, 8);
    return `otel-javascript-${uniqueId}`;
  }

  private async ensureLogGroupExists() {
    /* Ensure the log group exists, create if it doesn't. */
    const res = await this.logsClient.describeLogGroups({
      logGroupNamePrefix: this.logGroupName,
      limit: 1,
    });

    if (!res.logGroups || res.logGroups.length === 0) {
      try {
        await this.logsClient.createLogGroup({
          logGroupName: this.logGroupName,
        });
        diag.info(`Created log group: ${this.logGroupName}`);
      } catch (e) {
        diag.error(`Failed to create log group ${this.logGroupName}: ${e}`);
        throw e;
      }
    } else {
      diag.info(`Log group ${this.logGroupName} exists`);
    }
  }

  private async ensureLogStreamExists() {
    /* Ensure the log stream exists, create if it doesn't. */
    try {
      await this.logsClient.createLogStream({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
      });

      diag.debug(`Created log stream: ${this.logStreamName}`);
      this.logStreamExists = true;
      return true;
    } catch (e) {
      diag.debug(`Error when creating log stream "${this.logStreamName}": ${e}`);
      throw e;
    }
  }

  private getMetricName(record: MetricRecord): string | undefined {
    /* Get the metric name from the metric record or data point. */
    if (record.name) {
      return record.name;
    }

    return undefined;
  }

  /**
   * Get CloudWatch unit from unit in MetricRecord
   *
   * @param record Metric Record
   * @returns {string | undefined}
   */
  private getUnit(record: MetricRecord): string | undefined {
    const unit = record.unit;

    if (this.EMF_SUPPORTED_UNITS.has(unit)) {
      return unit;
    }

    return this.UNIT_MAPPING.get(unit);
  }

  /**
   * Extract dimension names from attributes.
   * For now, use all attributes as dimensions for the dimension selection logic.
   *
   * @param attributes OpenTelemetry Attributes to extract Dimension Names from
   * @returns
   */
  private getDimensionNames(attributes: Attributes): string[] {
    return Object.keys(attributes);
  }

  /**
   * Create a hashable key from attributes for grouping metrics.
   *
   * @param attributes OpenTelemetry Attributes used to create an attributes key
   * @returns {string}
   */
  private getAttributesKey(attributes: Attributes): string {
    // Sort the attributes to ensure consistent keys
    const sortedAttrs = Object.entries(attributes).sort();
    // Create a string representation of the attributes
    return sortedAttrs.toString();
  }

  /**
   * Normalize an OpenTelemetry timestamp to milliseconds for CloudWatch.
   *
   * @param hrTime Datapoint timestamp
   * @returns {number} Timestamp in milliseconds
   */
  private normalizeTimestamp(hrTime: HrTime): number {
    // Convert from second and nanoseconds to milliseconds
    const secondsToMillis = hrTime[0] * 1000;
    const nanosToMillis = Math.floor(hrTime[1] / 1_000_000);
    return secondsToMillis + nanosToMillis;
  }

  /**
   * Create a base metric record with instrument information.
   *
   * @param metricName Name of the metric
   * @param metricUnit Unit of the metric
   * @param metricDescription Description of the metric
   * @param timestamp Normalized end epoch timestamp when metric data was collected
   * @param attributes Attributes of the metric data
   * @returns {MetricRecord}
   */
  private createMetricRecord(
    metricName: string,
    metricUnit: string,
    metricDescription: string,
    timestamp: number,
    attributes: Attributes
  ): MetricRecord {
    const record: MetricRecord = {
      name: metricName,
      unit: metricUnit,
      description: metricDescription,
      timestamp,
      attributes,
    };

    return record;
  }

  /**
   * Convert a Gauge metric datapoint to a metric record.
   *
   * @param metric Gauge Metric Data
   * @param dataPoint The datapoint to convert
   * @returns {[MetricRecord, number]}
   */
  private convertGauge(metric: GaugeMetricData, dataPoint: DataPoint<number>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    // Create base record
    const metricRecord: MetricRecord = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    metricRecord.value = dataPoint.value; // For Gauge, set the value directly

    return metricRecord;
  }

  /**
   * Convert a Sum metric datapoint to a metric record.
   *
   * @param metric The metric object
   * @param dataPoint The datapoint to convert
   * @returns {[MetricRecord, number]}
   */
  private convertSum(metric: SumMetricData, dataPoint: DataPoint<number>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    // Create base record
    const record: MetricRecord = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    record.sumData = dataPoint.value;

    return record;
  }

  /**
   * Convert a Histogram metric datapoint to a metric record.
   *
   * @param metric The metric object
   * @param dataPoint The datapoint to convert
   * @returns {[MetricRecord, number]}
   */
  private convertHistogram(metric: HistogramMetricData, dataPoint: DataPoint<Histogram>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);

    // Create base record
    const record: MetricRecord = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    record.histogramData = {
      // For Histogram, set the histogram_data
      Count: dataPoint.value.count,
      Sum: dataPoint.value.sum ?? 0,
      Min: dataPoint.value.min ?? 0,
      Max: dataPoint.value.max ?? 0,
    };

    return record;
  }

  /**
   * Convert an ExponentialHistogram metric datapoint to a metric record.
   * This function follows the logic of CalculateDeltaDatapoints in the Go implementation,
   * converting exponential buckets to their midpoint values.
   *
   * @param metric The metric object
   * @param dataPoint The datapoint to convert
   * @returns {[MetricRecord, number]}
   */
  private convertExpHistogram(
    metric: ExponentialHistogramMetricData,
    dataPoint: DataPoint<ExponentialHistogram>
  ): MetricRecord {
    // Set timestamp
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);

    // Initialize arrays for values and counts
    const arrayValues = [];
    const arrayCounts = [];

    // Get scale
    const scale = dataPoint.value.scale;
    // Calculate base using the formula: 2^(2^(-scale))
    const base = Math.pow(2, Math.pow(2, -scale));

    // Process positive buckets
    if (dataPoint.value?.positive?.bucketCounts) {
      const positiveOffset = dataPoint.value.positive.offset ?? 0;
      const positiveBucketCounts = dataPoint.value.positive.bucketCounts;

      let bucketBegin = 0;
      let bucketEnd = 0;

      for (const [i, count] of positiveBucketCounts.entries()) {
        const index = i + positiveOffset;

        if (bucketBegin === 0) {
          bucketBegin = Math.pow(base, index);
        } else {
          bucketBegin = bucketEnd;
        }

        bucketEnd = Math.pow(base, index + 1);

        // Calculate midpoint value of the bucket
        const metricVal = (bucketBegin + bucketEnd) / 2;

        // Only include buckets with positive counts
        if (count > 0) {
          arrayValues.push(metricVal);
          arrayCounts.push(count);
        }
      }
    }

    // Process zero bucket
    const zeroCount = dataPoint.value.zeroCount ?? 0;
    if (zeroCount > 0) {
      arrayValues.push(0);
      arrayCounts.push(zeroCount);
    }

    // Process negative buckets
    if (dataPoint.value.negative.bucketCounts) {
      const negativeOffset = dataPoint.value.negative.offset ?? 0;
      const negativeBucketCounts = dataPoint.value.negative.bucketCounts;

      let bucketBegin = 0;
      let bucketEnd = 0;

      for (const [i, count] of Object.entries(negativeBucketCounts)) {
        const index = parseInt(i) + negativeOffset;

        if (bucketEnd === 0) {
          bucketEnd = -Math.pow(base, index);
        } else {
          bucketEnd = bucketBegin;
        }

        bucketBegin = -Math.pow(base, index + 1);

        // Calculate midpoint value of the bucket
        const metricVal = (bucketBegin + bucketEnd) / 2;

        // Only include buckets with positive counts
        if (count > 0) {
          arrayValues.push(metricVal);
          arrayCounts.push(count);
        }
      }
    }

    // Create base record
    const metricRecord = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    metricRecord.expHistogramData = {
      // Set the histogram data in the format expected by CloudWatch EMF
      Values: arrayValues,
      Counts: arrayCounts,
      Count: dataPoint.value.count,
      Sum: dataPoint.value.sum ?? 0,
      Max: dataPoint.value.max ?? 0,
      Min: dataPoint.value.min ?? 0,
    };

    return metricRecord;
  }

  /**
   * Group metric record by attributes and timestamp.
   *
   * @param record The metric record
   * @param timestampMs The timestamp in milliseconds
   * @returns {[string, number]} Values for the key to group metrics
   */
  private groupByAttributesAndTimestamp(record: MetricRecord): [string, number] {
    // Create a key for grouping based on attributes
    const attrsKey = this.getAttributesKey(record.attributes);
    return [attrsKey, record.timestamp];
  }

  private createEmfLog(metricRecords: MetricRecord[], resource: Resource, timestamp: number | undefined = undefined) {
    /*
        Create EMF log dictionary from metric records.
        
        Since metric_records is already grouped by attributes, this function
        creates a single EMF log for all records.
        */
    // Start with base structure
    const emfLog: EMFLog = {
      _aws: {
        Timestamp: timestamp || Date.now(),
        CloudWatchMetrics: [],
      },
      Version: '1',
    };

    // Add resource attributes to EMF log but not as dimensions
    if (resource && resource.attributes) {
      for (const [key, value] of Object.entries(resource.attributes)) {
        emfLog[`otel.resource.${key}`] = value?.toString() ?? 'undefined';
      }
    }
    // Initialize collections for dimensions and metrics
    // Attributes of each record in the list should be the same
    const allAttributes: Attributes = metricRecords.length > 0 ? metricRecords[0].attributes : {};
    const metricDefinitions = [];

    // Process each metric record
    for (const record of metricRecords) {
      const metricName = this.getMetricName(record);
      // Skip processing if metric name is undefined
      if (!metricName) {
        continue;
      }

      // Process different types of aggregations
      if (record.expHistogramData) {
        // Base2 Exponential Histogram - Store value directly in emfLog
        emfLog[metricName] = record.expHistogramData;
      } else if (record.histogramData) {
        // Regular Histogram metrics - Store value directly in emfLog
        emfLog[metricName] = record.histogramData;
      } else if (record.sumData) {
        // Counter/UpDownCounter - Store value directly in emfLog
        emfLog[metricName] = record.sumData;
      } else {
        // Other aggregations (e.g., LastValue)
        if (record.value) {
          // Store value directly in emfLog
          emfLog[metricName] = record.value;
        } else {
          diag.debug(`Skipping metric ${metricName} as it does not have valid metric value`);
          continue;
        }
      }

      // Create metric data
      const metricData: Metric = {
        Name: metricName,
      };

      const unit = this.getUnit(record);
      if (unit) {
        metricData['Unit'] = unit;
      }
      // Add to metric definitions list
      metricDefinitions.push(metricData);
    }
    // Get dimension names from collected attributes
    const dimensionNames = this.getDimensionNames(allAttributes);

    // Add attribute values to the root of the EMF log
    for (const [name, value] of Object.entries(allAttributes)) {
      emfLog[name] = value?.toString() ?? 'undefined';
    }

    // Add the single dimension set to CloudWatch Metrics if we have dimensions and metrics
    if (dimensionNames && metricDefinitions) {
      emfLog['_aws']['CloudWatchMetrics'].push({
        Namespace: this.namespace,
        Dimensions: [dimensionNames],
        Metrics: metricDefinitions,
      });
    }

    return emfLog;
  }

  private pushMetricRecordIntoGroupedMetrics(
    groupedMetrics: Map<string, Map<number, MetricRecord[]>>,
    groupAttribute: string,
    groupTimestamp: number,
    record: MetricRecord
  ) {
    let metricsGroupedByAttribute = groupedMetrics.get(groupAttribute);
    if (!metricsGroupedByAttribute) {
      metricsGroupedByAttribute = new Map<number, MetricRecord[]>();
      groupedMetrics.set(groupAttribute, metricsGroupedByAttribute);
    }

    let metricsGroupedByAttributeAndTimestamp = metricsGroupedByAttribute.get(groupTimestamp);
    if (!metricsGroupedByAttributeAndTimestamp) {
      metricsGroupedByAttributeAndTimestamp = [];
      metricsGroupedByAttribute.set(groupTimestamp, metricsGroupedByAttributeAndTimestamp);
    }
    metricsGroupedByAttributeAndTimestamp.push(record);
  }

  public async export(resourceMetrics: ResourceMetrics, resultCallback: (result: ExportResult) => void) {
    /*
        Export metrics as EMF logs to CloudWatch.
        
        Groups metrics by attributes and timestamp before creating EMF logs.
        
        Args:
            resourceMetrics: MetricsData containing resource metrics and scope metrics
            timeout_millis: Optional timeout in milliseconds
            **kwargs: Additional keyword arguments
            
        Returns:
            MetricExportResult indicating success or failure
        */
    try {
      if (!resourceMetrics) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }

      // Process all metrics from resource metrics their scope metrics
      // The resource is now part of each resource_metrics object
      const resource = resourceMetrics.resource;

      for (const scopeMetrics of resourceMetrics.scopeMetrics /*resource_metrics.scope_metrics*/) {
        // Dictionary to group metrics by attributes and timestamp
        // Key: (attributes_key, timestamp_ms)
        // Value: list of metric records
        const groupedMetrics = new Map<string, Map<number, MetricRecord[]>>();

        // Process all metrics in this scope
        for (const metric of scopeMetrics.metrics) {
          // Convert metrics to a format compatible with create_emf_log
          // Process metric.dataPoints for different metric types
          if (metric.dataPointType === DataPointType.GAUGE) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertGauge(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else if (metric.dataPointType === DataPointType.SUM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertSum(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else if (metric.dataPointType === DataPointType.HISTOGRAM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertHistogram(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else if (metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertExpHistogram(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else {
            // This else block should never run, all metric types are accounted for above
            diag.debug(`Unsupported Metric Type in metric: ${metric}`);
          }
        }

        const sendLogEventPromises: Promise<void>[] = [];
        // Now process each group separately to create one EMF log per group
        groupedMetrics.forEach((metricsRecordsGroupedByAttribute: Map<number, MetricRecord[]>, attrsKey: string) => {
          // metricRecords is grouped by attribute and timestamp
          metricsRecordsGroupedByAttribute.forEach((metricRecords: MetricRecord[], timestampMs: number) => {
            if (metricRecords) {
              diag.debug(`Creating EMF log for group with ${metricRecords.length} metrics.
                                            Timestamp: ${timestampMs}, Attributes: ${attrsKey.substring(0, 100)}...`);

              // Create EMF log for this batch of metrics with the group's timestamp
              const emfLog = this.createEmfLog(metricRecords, resource, Number(timestampMs));

              // Convert to JSON
              const logEvent = {
                message: JSON.stringify(emfLog),
                timestamp: timestampMs,
              };

              // Send to CloudWatch Logs
              sendLogEventPromises.push(this.sendLogEvent(logEvent));
            }
          });
        });
        await Promise.all(sendLogEventPromises);
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    } catch (e) {
      diag.error(`Failed to export metrics: ${e}`);
      resultCallback({ code: ExportResultCode.FAILED, error: e as Error });
      return;
    }
  }

  /**
   * Validate the log event according to CloudWatch Logs constraints.
   * Implements the same validation logic as the Go version.
   *
   * @param logEvent The log event to validate
   * @returns {boolean}
   */
  private validateLogEvent(logEvent: LogEvent): boolean {
    const message = logEvent.message;
    const timestamp = logEvent.timestamp;

    // Check message size
    const messageSize = message.length + CW_PER_EVENT_HEADER_BYTES;
    if (messageSize > CW_MAX_EVENT_PAYLOAD_BYTES) {
      diag.warn(`Log event size ${messageSize} exceeds maximum allowed size {CW_MAX_EVENT_PAYLOAD_BYTES}. Truncating.`);
      const maxMessageSize = CW_MAX_EVENT_PAYLOAD_BYTES - CW_PER_EVENT_HEADER_BYTES - CW_TRUNCATED_SUFFIX.length;
      logEvent['message'] = message.substring(0, maxMessageSize) + CW_TRUNCATED_SUFFIX;
    }

    // Check empty message
    if (logEvent.message === '') {
      diag.error('Empty log event message');
      return false;
    }

    // Check timestamp constraints
    const currentTime = Date.now(); // Current time in milliseconds
    const eventTime = timestamp;

    // Calculate the time difference
    const timeDiff = currentTime - eventTime;

    // Check if too old or too far in the future
    if (timeDiff > CW_EVENT_TIMESTAMP_LIMIT_PAST || timeDiff < -CW_EVENT_TIMESTAMP_LIMIT_FUTURE) {
      diag.error(
        `Log event timestamp ${eventTime} is either older than 14 days or more than 2 hours in the future.
                Current time: ${currentTime}`
      );
      return false;
    }

    return true;
  }

  /**
   * Create a new log event batch
   *
   * @returns {EventBatch}
   */
  private createEventBatch(): EventBatch {
    return {
      logEvents: [],
      byteTotal: 0,
      minTimestampMs: 0,
      maxTimestampMs: 0,
      createdTimestampMs: Date.now(),
    };
  }

  /**
   * Check if adding the next event would exceed CloudWatch Logs limits.
   *
   * @param batch The current batch
   * @param nextEventSize Size of the next event in bytes CW_MAX_REQUEST_EVENT_COUNT
   * @returns {boolean} true if adding the next event would exceed limits
   */
  private eventBatchExceedsLimit(batch: EventBatch, nextEventSize: number): boolean {
    return (
      batch.logEvents.length >= CW_MAX_REQUEST_EVENT_COUNT ||
      batch.byteTotal + nextEventSize > CW_MAX_REQUEST_PAYLOAD_BYTES
    );
  }

  /**
   * Check if the event batch spans more than 24 hours.
   *
   * @param batch The event batch
   * @param targetTimestampMs The timestamp of the event to add
   * @returns {boolean} true if the batch is active and can accept the event
   */
  private isBatchActive(batch: EventBatch, targetTimestampMs: number): boolean {
    // New log event batch
    if (batch.minTimestampMs === 0 || batch.maxTimestampMs === 0) {
      return true;
    }

    // Check if adding the event would make the batch span more than 24 hours
    if (targetTimestampMs - batch.minTimestampMs > 24 * 3600 * 1000) {
      return false;
    }

    if (batch.maxTimestampMs - targetTimestampMs > 24 * 3600 * 1000) {
      return false;
    }

    // flush the event batch when reached 60s interval
    const currentTime = Date.now();
    if (currentTime - batch.createdTimestampMs >= BATCH_FLUSH_INTERVAL) {
      return false;
    }

    return true;
  }

  /**
   * Append a log event to the batch.
   *
   * @param batch The event batch
   * @param logEvent The log event to append
   * @param eventSize Size of the event in bytes
   */
  private appendToBatch(batch: EventBatch, logEvent: LogEvent, eventSize: number) {
    batch.logEvents.push(logEvent);
    batch.byteTotal += eventSize;

    const timestamp = logEvent.timestamp;
    if (batch.minTimestampMs === 0 || batch.minTimestampMs > timestamp) {
      batch.minTimestampMs = timestamp;
    }

    if (batch.maxTimestampMs === 0 || batch.maxTimestampMs < timestamp) {
      batch.maxTimestampMs = timestamp;
    }
  }

  /**
   * Sort log events in the batch by timestamp.
   *
   * @param batch The event batch
   */
  private sortLogEvents(batch: EventBatch) {
    batch.logEvents = batch.logEvents.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Send a batch of log events to CloudWatch Logs.
   *
   * @param batch The event batch
   * @returns {Promise<void>}
   */
  private async sendLogBatch(batch: EventBatch) {
    if (!batch['logEvents'] || batch['logEvents'].length === 0) {
      return;
    }

    // Sort log events by timestamp
    this.sortLogEvents(batch);

    // Prepare the PutLogEvents request
    const putLogEventsInput: PutLogEventsCommandInput = {
      logStreamName: this.logStreamName,
      logEvents: batch['logEvents'],
      logGroupName: this.logGroupName,
    };

    // let start_time = time.time()
    const startTime = Date.now();

    try {
      if (!this.logStreamExists) {
        // Must perform logGroupExists check here because promises cannot be "awaited" in constructor
        await this.logStreamExistsPromise;
      }

      // Make the PutLogEvents call
      await this.logsClient.putLogEvents(putLogEventsInput);

      const elapsedMs = Date.now() - startTime;
      diag.debug(
        `Successfully sent ${batch['logEvents'].length} log events
                (${(batch['byteTotal'] / 1024).toFixed(2)} KB) in ${elapsedMs} ms`
      );
    } catch (e) {
      diag.error(`Failed to send log events: ${e}`);
      throw e;
    }
  }

  /**
   * Send a log event to CloudWatch Logs.
   *
   * This function implements the same logic as the Go version in the OTel Collector.
   * It batches log events according to CloudWatch Logs constraints and sends them
   * when the batch is full or spans more than 24 hours.
   *
   * @param logEvent The log event to send
   * @returns {Promise<void>}
   */
  private async sendLogEvent(logEvent: LogEvent) {
    try {
      // Validate the log event
      if (!this.validateLogEvent(logEvent)) {
        return;
      }

      // Calculate event size
      const eventSize = logEvent['message'].length + CW_PER_EVENT_HEADER_BYTES;

      // Initialize event batch if needed
      if (this.eventBatch === undefined) {
        this.eventBatch = this.createEventBatch();
      }

      // Check if we need to send the current batch and create a new one
      let currentBatch = this.eventBatch;
      if (
        this.eventBatchExceedsLimit(currentBatch, eventSize) ||
        !this.isBatchActive(currentBatch, logEvent['timestamp'])
      ) {
        // Create a new batch
        this.eventBatch = this.createEventBatch();
        // Send the current batch
        await this.sendLogBatch(currentBatch);
        currentBatch = this.eventBatch;
      }

      // Add the log event to the batch
      this.appendToBatch(currentBatch, logEvent, eventSize);
    } catch (e) {
      diag.error(`Failed to process log event: ${e}`);
      throw e;
    }
  }

  /**
   * Force flush any pending metrics.
   *
   * @param timeoutMillis Timeout in milliseconds
   */
  public async forceFlush(timeoutMillis: number = 10000) {
    if (this.eventBatch !== undefined && this.eventBatch['logEvents'].length > 0) {
      const currentBatch = this.eventBatch;
      this.eventBatch = this.createEventBatch();
      await this.sendLogBatch(currentBatch);
    }
    diag.debug('CloudWatchEMFExporter force flushes the bufferred metrics');
  }

  /**
   * Shutdown the exporter.
   *
   * @returns {Promise<void>}
   */
  public async shutdown() {
    await this.forceFlush();
    diag.debug('CloudWatchEMFExporter shutdown called');
    return Promise.resolve();
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this.aggregationTemporality;
  }

  selectAggregation(instrumentType: InstrumentType): Aggregation {
    switch (instrumentType) {
      case InstrumentType.HISTOGRAM: {
        return Aggregation.ExponentialHistogram();
      }
    }
    return Aggregation.Default();
  }
}

/**
 * Convenience function to create a CloudWatch EMF exporter with DELTA temporality.
 *
 * @param namespace CloudWatch namespace for metrics
 * @param logGroupName CloudWatch log group name
 * @param logStreamName CloudWatch log stream name (auto-generated if not provided)
 * @param cloudwatchLogsConfig: CloudWatch Logs Client Configuration
 * @returns {CloudWatchEMFExporter} Configured CloudWatchEMFExporter instance
 */
export function createEmfExporter(
  namespace: string = 'OTelJavaScript',
  logGroupName: string = '/aws/otel/javascript',
  logStreamName?: string,
  cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}
): CloudWatchEMFExporter {
  return new CloudWatchEMFExporter(
    namespace,
    logGroupName,
    logStreamName,
    AggregationTemporality.DELTA, // Set up temporality preference - always use DELTA for CloudWatch
    cloudwatchLogsConfig
  );
}
