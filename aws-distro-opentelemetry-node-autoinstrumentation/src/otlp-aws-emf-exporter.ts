// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry EMF (Embedded Metric Format) Exporter for CloudWatch.
 * This exporter converts OTel metrics into CloudWatch EMF format.
 */

import { Attributes, diag, HrTime } from '@opentelemetry/api';
import {
  CloudWatchLogsClient,
  CloudWatchLogsClientConfig,
  DescribeLogGroupsCommand,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  PutLogEventsCommandInput,
} from '@aws-sdk/client-cloudwatch-logs';
import {
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
import * as Crypto from 'crypto'

// Constants for CloudWatch Logs limits
const CW_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 256KB
const CW_MAX_REQUEST_EVENT_COUNT = 10000;
const CW_PER_EVENT_HEADER_BYTES = 26;
const BATCH_FLUSH_INTERVAL = 60 * 1000;
const CW_MAX_REQUEST_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB
const CW_TRUNCATED_SUFFIX = '[Truncated...]';
const CW_EVENT_TIMESTAMP_LIMIT_PAST = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
const CW_EVENT_TIMESTAMP_LIMIT_FUTURE = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

const RECORD_DATA_TYPES = {
  SUM_DATA: 'SUM_DATA',
  HISTOGRAM_DATA: 'HISTOGRAM_DATA',
  EXP_HISTOGRAM_DATA: 'EXP_HISTOGRAM_DATA',
}

interface Record {
  //[]MetricRecord
  timestamp: number;
  attributes: Attributes;
  sumData?: RecordData;
  histogramData?: RecordData;
  expHistogramData?: RecordData;
  value?: number;
  instrument: Instrument;
}

interface RecordData {
  type: string,
  value: RecordValue | number
}

interface RecordValue {
  Values?: number[],
  Counts?: number[],
  Count: number,
  Sum: number,
  Max: number,
  Min: number,
}

interface Instrument {
  name: string;
  unit: string;
  description: string;
}

export interface EMFLogInterface {
  'EC2.AutoScalingGroup'?: string;
  'Telemetry.Extended'?: string;
  Service?: string;
  Error?: EmfLogError;
  Host?: string;
  Fault?: Fault;
  Operation?: string;
  Latency?: Latency;
  'K8s.Namespace'?: string;
  _aws: Aws;
  'K8s.Node'?: string;
  'EC2.InstanceId'?: string;
  'Telemetry.SDK'?: string;
  Environment?: string;
  'K8s.WorkLoad'?: string;
  'aws.log.group.names'?: string;
  PlatformType?: string;
  [key: `resource.${string}`]: string;
  [metricName: string]: string | EmfLogError | Fault | undefined | Aws | RecordValue | number;
  Version: string
}

export interface EmfLogError {
  Counts: number[];
  Min: number;
  Max: number;
  Values: number[];
  Sum: number;
  Count: number;
}

export interface Fault {
  Counts: number[];
  Min: number;
  Max: number;
  Values: number[];
  Sum: number;
  Count: number;
}

export interface Latency {
  Counts: number[];
  Min: number;
  Max: number;
  Values: number[];
  Sum: number;
  Count: number;
}

export interface Aws {
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
//[]   private metricDeclarations: {}[];
//[]   private parseJsonEncodedAttrValues: boolean;
  private aggregationTemporality: AggregationTemporality;

  private logsClient: CloudWatchLogsClient;
  private logGroupExists: boolean;
  private logGroupExistsPromise: Promise<boolean>;
  // Event batch to store logs before sending to CloudWatch
  private eventBatch: undefined | EventBatch = undefined;

  // OTel to CloudWatch unit mapping
  //[]fix interface
  private UNIT_MAPPING: { [key: string]: string } = {
    ms: 'Milliseconds',
    s: 'Seconds',
    us: 'Microseconds',
    ns: 'Nanoseconds',
    By: 'Bytes',
    KiBy: 'Kilobytes',
    MiBy: 'Megabytes',
    GiBy: 'Gigabytes',
    TiBy: 'Terabytes',
    Bi: 'Bits',
    KiBi: 'Kilobits',
    MiBi: 'Megabits',
    GiBi: 'Gigabits',
    TiBi: 'Terabits',
    '%': 'Percent',
    '1': 'Count',
    '{count}': 'Count',
  };

  /**
   * Initialize the CloudWatch EMF exporter.
   *
   * @param namespace CloudWatch namespace for metrics
   * @param logGroupName CloudWatch log group name
   * @param logStreamName CloudWatch log stream name (auto-generated if None)
   * @param awsRegion AWS region (auto-detected if None)
   * @param metricDeclarations Optional metric declarations for filtering
   * @param parseJsonEncodedAttrValues Whether to parse JSON-encoded attribute values
   * @param preferredTemporality Optional dictionary mapping instrument types to aggregation temporality
   * @param AggregationTemporality Additional arguments passed to boto3 client
   */
  constructor(
    namespace: string = 'default',
    logGroupName: string | undefined,
    logStreamName: string | undefined,
    awsRegion: string | undefined,
    metricDeclarations: {}[] | undefined,
    parseJsonEncodedAttrValues: boolean = true,
    //[] preferred_temporality: Record<type, AggregationTemporality> | undefined,
    aggregationTemporality: AggregationTemporality,
    //[] **kwargs
    cloudwatchLogsConfig: CloudWatchLogsClientConfig
  ) {
    //[]super().__init__(preferred_temporality)

    this.namespace = namespace;
    this.logGroupName = logGroupName;
    this.logStreamName = logStreamName || this.generateLogStreamName();
    //[] this.metricDeclarations = metricDeclarations || [];
    // this.parseJsonEncodedAttrValues = parseJsonEncodedAttrValues;
    this.aggregationTemporality = aggregationTemporality;

    // Initialize CloudWatch Logs client
    //[] session = boto3.Session(region_name=aws_region)
    // this.logs_client = session.client("logs", **kwargs)
    this.logsClient = new CloudWatchLogsClient(cloudwatchLogsConfig);

    // Ensure log group exists
    this.logGroupExists = false;
    this.logGroupExistsPromise = this.ensureLogGroupExists();
  }

  private generateLogStreamName(): string {
    /* Generate a unique log stream name. */
    // import uuid

    // unique_id = str(uuid.uuid4())[:8]
    const uniqueId = Crypto.randomUUID().substring(0, 8);
    return `otel-js-${uniqueId}`;
  }

  private async ensureLogGroupExists() {
    if (this.logGroupExists) {
      return true;
    }

    /* Ensure the log group exists, create if it doesn't. */
    //[] try {
      //[][][][] Should this be non blocking???????
      let res = await this.logsClient.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: this.logGroupName,
          limit: 1,
        })
      );
    // } catch (e) {

      if (!res.logGroups || res.logGroups.length === 0) {
      try {
        await this.logsClient.send(
          new CreateLogGroupCommand({
            logGroupName: this.logGroupName,
          })
        );
        diag.info(`Created log group: ${this.logGroupName}`);
      } catch (e) {
        diag.error(`Failed to create log group ${this.logGroupName}: ${e}`);
        this.logGroupExists = false;
        throw e;
      }
    }
    // }

    this.logGroupExists = true;
    return true;
  }

  private getMetricName(record: Record): string {
    /* Get the metric name from the metric record or data point. */
    // For metrics in MetricsData format
    //[][] if ('name' in record) {
    //[][]     return record.name
    //[][] // For compatibility with older record format
    //[][] } else if ('instrument' in record && 'name' in record.instrument) {
    if (record.instrument?.name) {
      return record.instrument.name;
    } else {
      // Fallback with generic name
      return 'unknown_metric';
    }
  }

  //[][] instrument_or_metric not a good name because is only of type Instrument?
  private getUnit(instrumentOrMetric: Instrument): string | undefined {
    /* Get CloudWatch unit from OTel instrument or metric unit. */
    // Check if we have an Instrument object or a metric with unit attribute
    //[] let unit;
    //[][][Do I really need this?] if (instrument_or_metric instanceof Instrument){
    const unit = instrumentOrMetric.unit;
    //[][] }else{
    //[][]     unit = instrument_or_metric['unit'] ?? undefined
    //[][] }
    if (!unit) {
      return undefined;
    }
    return this.UNIT_MAPPING[unit] ?? unit;
  }

  private getDimensionNames(attributes: Attributes): string[] {
    /* Extract dimension names from attributes. */
    // Implement dimension selection logic
    // For now, use all attributes as dimensions
    return Object.keys(attributes);
  }

  private getAttributesKey(attributes: Attributes): string {
    /*
        Create a hashable key from attributes for grouping metrics.
        
        Args:
            attributes: The attributes dictionary
            
        Returns:
            A string representation of sorted attributes key-value pairs
        */
    // Sort the attributes to ensure consistent keys
    const sortedAttrs = Object.entries(attributes).sort();
    // Create a string representation of the attributes
    return sortedAttrs.toString();
  }

  private normalizeTimestamp(hrTime: HrTime): number {
    /*
        Normalize a nanosecond timestamp to milliseconds for CloudWatch.
        
        Args:
            timestamp_ns: Timestamp in nanoseconds
            
        Returns:
            Timestamp in milliseconds
        */
    // Convert from nanoseconds to milliseconds
    const secondsToMillis = hrTime[0] * 1000;
    const nanosToMillis = parseInt(`${hrTime[1] / 1000}`);
    return secondsToMillis + nanosToMillis;
  }

  private createMetricRecord(metricName: string, metricUnit: string, metricDescription: string) {
    /*Create a base metric record with instrument information.
        
        Args:
            metric_name: Name of the metric
            metric_unit: Unit of the metric
            metric_description: Description of the metric
            
        Returns:
            A base metric record object
        */
    //[][] let record = type('MetricRecord', (), {})()
    // record.instrument = type('Instrument', (), {})()
    // record.instrument.name = metric_name
    // record.instrument.unit = metric_unit
    // record.instrument.description = metric_description

    const record = {
      instrument: {
        name: metricName,
        unit: metricUnit,
        description: metricDescription,
      },
    };

    return record;
  }

  private convertGauge(metric: GaugeMetricData, dp: DataPoint<number>): [Record, number] {
    /*Convert a Gauge metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */

    //[] dp.endTime? seems like the only one... same goes for all other use of normalizeTimestamp //[] let timestamp_ms = this.normalize_timestamp(dp.time_unix_nano) if 'time_unix_nano' in dp else int(time.time() * 1000)
    const timestampMs = this.normalizeTimestamp(dp.endTime);
    // Create base record
    const record: Record = {
      ...this.createMetricRecord(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
      timestamp: timestampMs, // Set timestamp
      attributes: dp.attributes, // Set attributes
      value: dp.value, // For Gauge, set the value directly
    };

    return [record, timestampMs];
  }

  private convertSum(metric: SumMetricData, dp: DataPoint<number>): [Record, number] {
    /*Convert a Sum metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */

    const timestampMs = this.normalizeTimestamp(dp.endTime);
    // Create base record
    const record: Record = {
      ...this.createMetricRecord(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
      timestamp: timestampMs, // Set timestamp
      attributes: dp.attributes, // Set attributes

      sumData: {  // For Sum, set the sumData
        value: dp.value,
        type: RECORD_DATA_TYPES.SUM_DATA
      }
    };

    return [record, timestampMs];
  }

  private convertHistogram(metric: HistogramMetricData, dp: DataPoint<Histogram>): [Record, number] {
    /*Convert a Histogram metric datapoint to a metric record.

        https://github.com/mircohacker/opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/datapoint.go#L148
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */

    const timestampMs = this.normalizeTimestamp(dp.endTime);

    // Create base record
    const record: Record = {
      ...this.createMetricRecord(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
      timestamp: timestampMs, // Set timestamp
      attributes: dp.attributes, // Set attributes

      histogramData: {
        value: {
          // For Histogram, set the histogram_data
          Count: dp.value.count,
          Sum: dp.value.sum ?? 0,
          Min: dp.value.min ?? 0,
          Max: dp.value.max ?? 0,
        },
        type: RECORD_DATA_TYPES.HISTOGRAM_DATA
      }
    };

    return [record, timestampMs];
  }

  private convertExpHistogram(
    metric: ExponentialHistogramMetricData,
    dp: DataPoint<ExponentialHistogram>
  ): [Record, number] {
    /*
        Convert an ExponentialHistogram metric datapoint to a metric record.
        
        This function follows the logic of CalculateDeltaDatapoints in the Go implementation,
        converting exponential buckets to their midpoint values.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */

    // Set timestamp
    const timestampMs = this.normalizeTimestamp(dp.endTime);

    // Initialize arrays for values and counts
    const arrayValues = [];
    const arrayCounts = [];

    // Get scale
    const scale = dp.value.scale;
    // Calculate base using the formula: 2^(2^(-scale))
    const base = Math.pow(2, Math.pow(2, -scale));

    // Process positive buckets
    // if ('positive' in dp && 'bucketCounts' in dp.value.positive && dp.positive.bucket_counts) {
    if (dp.value?.positive?.bucketCounts) {
      const positiveOffset = dp.value.positive.offset ?? 0;
      const positiveBucketCounts = dp.value.positive.bucketCounts;

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
    const zeroCount = dp.value.zeroCount ?? 0;
    if (zeroCount > 0) {
      arrayValues.push(0);
      arrayCounts.push(zeroCount);
    }

    // Process negative buckets
    if (dp.value.negative.bucketCounts) {
      const negativeOffset = dp.value.negative.offset ?? 0;
      const negativeBucketCounts = dp.value.negative.bucketCounts;

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
    const record: Record = {
      ...this.createMetricRecord(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
      timestamp: timestampMs,
      attributes: dp.attributes, // Set attributes

      expHistogramData: {
        value: {
          // Set the histogram data in the format expected by CloudWatch EMF
          Values: arrayValues,
          Counts: arrayCounts,
          Count: dp.value.count,
          Sum: dp.value.sum ?? 0,
          Max: dp.value.max ?? 0,
          Min: dp.value.min ?? 0,
        },
        type: RECORD_DATA_TYPES.HISTOGRAM_DATA
      }
    };

    return [record, timestampMs];
  }

  private groupByAttributesAndTimestamp(record: Record, timestampMs: number): [string, number] {
    /*Group metric record by attributes and timestamp.
        
        Args:
            record: The metric record
            timestamp_ms: The timestamp in milliseconds
            
        Returns:
            A tuple key for grouping
        */
    // Create a key for grouping based on attributes
    const attrsKey = this.getAttributesKey(record.attributes);
    return [attrsKey, timestampMs];
  }

  private createEmfLog(metricRecords: Record[], resource: Resource, timestamp: number | undefined = undefined) {
    /*
        Create EMF log dictionary from metric records.
        
        Since metric_records is already grouped by attributes, this function
        creates a single EMF log for all records.
        */
    // Start with base structure
    const emfLog: EMFLogInterface = {
      _aws: {
        Timestamp: timestamp || parseInt(`${Date.now()}`),
        CloudWatchMetrics: [],
      },
      Version: '1'
    };

    // Add resource attributes to EMF log but not as dimensions
    if (resource && resource.attributes) {
      for (const [key, value] of Object.entries(resource.attributes)) {
        emfLog[`resource.${key}`] = value?.toString() ?? 'undefined'; // Python assumes not undefinable
      }
    }
    // Initialize collections for dimensions and metrics
    const allAttributes: Attributes = {};
    const metricDefinitions = [];

    // Process each metric record
    for (const record of metricRecords) {
      // Collect attributes from all records (they should be the same for all records in the group)
      if ('attributes' in record && record.attributes) {
        for (const [key, value] of Object.entries(record.attributes)) {
          allAttributes[key] = value;
        }
      }

      const metricName = this.getMetricName(record);
      const unit = this.getUnit(record.instrument);

      // Process different types of aggregations
      if (record.expHistogramData) {
        // Base2 Exponential Histogram - Store value directly in emf_log
        emfLog[metricName] = record.expHistogramData.value
      } else if (record.histogramData) {
        // Regular Histogram metrics - Store value directly in emf_log
        emfLog[metricName] = record.histogramData.value
      } else if (record.sumData) {
        // Counter/UpDownCounter - Store value directly in emf_log
        emfLog[metricName] = record.sumData.value;
      } else {
        // Other aggregations (e.g., LastValue)
        if (record.value) {
          // Store value directly in emf_log
          emfLog[metricName] = record.value;
        }
      }

      // Create metric data
      const metricData: Metric = {
        Name: metricName,
      };
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
    groupedMetrics: Map<string, Map<number, Record[]>>,
    groupAttribute: string,
    groupTimestamp: number,
    record: Record
  ) {
    let metricsGroupedByAttribute = groupedMetrics.get(groupAttribute);
    if (!metricsGroupedByAttribute) {
      metricsGroupedByAttribute = new Map<number, Record[]>();
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
        const groupedMetrics = new Map<string, Map<number, Record[]>>();

        // Process all metrics in this scope
        for (const metric of scopeMetrics.metrics) {
          // Convert metrics to a format compatible with create_emf_log
          // Access data points through metric.data.data_points
          if ('dataPoints' in metric) {
            // Process different metric types
            if (metric.dataPointType === DataPointType.GAUGE) {
              for (const dp of metric.dataPoints) {
                const [record, timestampMs] = this.convertGauge(metric, dp);
                const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record, timestampMs);
                this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
              }
            } else if (metric.dataPointType === DataPointType.SUM) {
              for (const dp of metric.dataPoints) {
                const [record, timestampMs] = this.convertSum(metric, dp);
                const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record, timestampMs);
                this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
              }
            } else if (metric.dataPointType === DataPointType.HISTOGRAM) {
              for (const dp of metric.dataPoints) {
                const [record, timestampMs] = this.convertHistogram(metric, dp);
                const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record, timestampMs);
                this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
              }
            } else if (metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
              for (const dp of metric.dataPoints) {
                const [record, timestampMs] = this.convertExpHistogram(metric, dp);
                const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record, timestampMs);
                this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
              }
            } else {
              diag.warn('Unsupported Metric Type: %s', (metric as any).dataPointType);
              continue; // Skip this metric but continue processing others
            }
          }
        }

        const sendLogEventPromises: Promise<void>[] = [];
        // Now process each group separately to create one EMF log per group
        groupedMetrics.forEach((metricsRecordsGroupedByAttribute: Map<number, Record[]>, attrsKey: string) => {
          // metricRecords is grouped by attribute and timestamp
          metricsRecordsGroupedByAttribute.forEach((metricRecords: Record[], timestampMs: number) => {
            if (metricRecords) {
              diag.debug(`Creating EMF log for group with ${metricRecords.length} metrics.
                                            Timestamp: ${timestampMs}, Attributes: ${attrsKey.substring(0, 100)}...`);

              // Create EMF log for this batch of metrics with the group's timestamp
              const emfLogDict = this.createEmfLog(metricRecords, resource, Number(timestampMs));

              // Convert to JSON
              const logEvent = {
                message: JSON.stringify(emfLogDict),
                timestamp: timestampMs,
              };

              // Send to CloudWatch Logs
              sendLogEventPromises.push(this.sendLogEvent(logEvent));
            }
          });
        });
        //[][] must we await all "sendLogEvents"?
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

  private validateLogEvent(logEvent: LogEvent): boolean {
    /*
        Validate the log event according to CloudWatch Logs constraints.
        Implements the same validation logic as the Go version.
        
        Args:
            log_event: The log event to validate
            
        Returns:
            bool: true if valid, false otherwise
        */
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
    const currentTime = parseInt(`${Date.now()}`); // Current time in milliseconds
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

  private createEventBatch(): EventBatch {
    /*
        Create a new log event batch.
        
        Returns:
            Dict: A new event batch
        */
    return {
      logEvents: [],
      byteTotal: 0,
      minTimestampMs: 0,
      maxTimestampMs: 0,
      createdTimestampMs: parseInt(`${Date.now()}`),
    };
  }

  private eventBatchExceedsLimit(batch: EventBatch, nextEventSize: number): boolean {
    /*
        Check if adding the next event would exceed CloudWatch Logs limits.
        
        Args:
            batch: The current batch
            nextEventSize: Size of the next event in bytes CW_MAX_REQUEST_EVENT_COUNT
            
        Returns:
            bool: true if adding the next event would exceed limits
        */
    return (
      batch.logEvents.length >= CW_MAX_REQUEST_EVENT_COUNT ||
      batch.byteTotal + nextEventSize > CW_MAX_REQUEST_PAYLOAD_BYTES
    );
  }

  private isBatchActive(batch: EventBatch, targetTimestampMs: number): boolean {
    /*
        Check if the event batch spans more than 24 hours.
        
        Args:
            batch: The event batch
            targetTimestampMs: The timestamp of the event to add
            
        Returns:
            bool: true if the batch is active and can accept the event
        */
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
    const currentTime = parseInt(`${Date.now()}`);
    if (currentTime - batch.createdTimestampMs >= BATCH_FLUSH_INTERVAL) {
      return false;
    }

    return true;
  }

  private appendToBatch(batch: EventBatch, logEvent: LogEvent, eventSize: number) {
    /*
        Append a log event to the batch.
        
        Args:
            batch: The event batch
            logEvent: The log event to append
            eventSize: Size of the event in bytes
        */
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

  private sortLogEvents(batch: EventBatch) {
    /*
        Sort log events in the batch by timestamp.
        
        Args:
            batch: The event batch
        */
    //[]batch["logEvents"] = sorted(batch["logEvents"], key=lambda x: x["timestamp"])
    batch.logEvents = batch.logEvents.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async sendLogBatch(batch: EventBatch) {
    /*
        Send a batch of log events to CloudWatch Logs.
        
        Args:
            batch: The event batch
        */
    if (!batch['logEvents']) {
      return;
    }

    if (!this.logGroupExists) {
      // Must perform logGroupExists check here because promises cannot be "awaited" in constructor
      await this.logGroupExistsPromise;
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
      // Create log group and stream if they don't exist
      try {
        await this.logsClient.send(
          new CreateLogGroupCommand({
            logGroupName: this.logGroupName,
          })
        );

        diag.debug(`Created log group: ${this.logGroupName}`);
      } catch (e) {
        diag.debug(`Error when creating log group "${this.logGroupName}": ${e}`);
      }

      // Create log stream if it doesn't exist
      try {
        await this.logsClient.send(
          new CreateLogStreamCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
          })
        );

        diag.debug(`Created log stream: ${this.logStreamName}`);
      } catch (e) {
        diag.debug(`Error when creating log stream "${this.logStreamName}": ${e}`);
      }

      // Make the PutLogEvents call
      const response = await this.logsClient.send(new PutLogEventsCommand(putLogEventsInput));

      const elapsedMs = parseInt(`${Date.now() - startTime}`);
      diag.debug(
        `Successfully sent ${batch['logEvents'].length} log events
                (${(batch['byteTotal'] / 1024).toFixed(2)} KB) in ${elapsedMs} ms`
      );

      return response;
    } catch (e) {
      diag.error(`Failed to send log events: ${e}`);
      throw e;
    }
  }

  private async sendLogEvent(logEvent: LogEvent) {
    /*
        Send a log event to CloudWatch Logs.
        
        This function implements the same logic as the Go version in the OTel Collector.
        It batches log events according to CloudWatch Logs constraints and sends them
        when the batch is full or spans more than 24 hours.
        
        Args:
            logEvent: The log event to send
        */
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

  public async forceFlush(timeoutMillis: number = 10000) {
    /*
        Force flush any pending metrics.
        
        Args:
            timeoutMillis: Timeout in milliseconds
            
        Returns:
            true if successful, false otherwise
        */
    if (this.eventBatch !== undefined && this.eventBatch['logEvents'].length > 0) {
      const currentBatch = this.eventBatch;
      this.eventBatch = this.createEventBatch();
      await this.sendLogBatch(currentBatch);
    }
    diag.debug('CloudWatchEMFExporter force flushes the bufferred metrics');
    return Promise.resolve();
  }

  public shutdown() {
    /*
        Shutdown the exporter.
        Override to handle timeout and other keyword arguments, but do nothing.
        
        Args:
            timeout_millis: Ignored timeout in milliseconds
            **kwargs: Ignored additional keyword arguments
        */
    // Intentionally do nothing
    diag.debug('CloudWatchEMFExporter shutdown called');
    return Promise.resolve();
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
      return this.aggregationTemporality;
  }
}
