// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry EMF (Embedded Metric Format) Exporter for CloudWatch.
 * This exporter converts OTel metrics into CloudWatch EMF format.
 */

// import json
// import os
// import time
// import logging
// from typing import Dict, List, Optional, Any, Union, Tuple
// from collections import defaultdict
// from dataclasses import dataclass, field

// import boto3
// from opentelemetry.sdk.metrics import (
//     Counter,
//     Histogram,
//     ObservableCounter,
//     ObservableGauge,
//     ObservableUpDownCounter,
//     UpDownCounter,
// )
// from opentelemetry.sdk.metrics.export import (
//     MetricExporter,
//     MetricExportResult,
//     MetricsData,
// )
// from opentelemetry.sdk.resources import Resource
// from opentelemetry.metrics import Instrument
// from opentelemetry.sdk.metrics.export import (
//     AggregationTemporality,
// )
// from opentelemetry.util.types import Attributes

import {
    Attributes,
  AttributeValue,
  diag,
  DiagLogLevel,
  HrTime,
} from '@opentelemetry/api';
import { CloudWatchLogsClient, CloudWatchLogsClientConfig, DescribeLogGroupsCommand, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { DataPoint, DataPointType, ExponentialHistogram, ExponentialHistogramMetricData, GaugeMetricData, Histogram, HistogramMetricData, MetricData, MetricDescriptor, PushMetricExporter, ResourceMetrics, SumMetricData } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

// logger = logging.getLogger(__name__)


// @dataclass
// class EMFMetricData:
//     /* Represents an EMF metric data point. */
//     unit: Optional[str] = None
//     timestamp: Optional[int] = None
//     values: List[Union[int, float]] = field(default_factory=list)
//     counts: List[int] = field(default_factory=list)
    
//     def to_dict(self) -> Dict:
//         /* Convert to dictionary for JSON serialization. */
//         return {
//             "unit": self.unit,
//             "values": self.values,
//             "counts": self.counts,
//         }

// Constants for CloudWatch Logs limits
const CW_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024  // 256KB
const CW_MAX_REQUEST_EVENT_COUNT = 10000
const CW_PER_EVENT_HEADER_BYTES = 26
const BATCH_FLUSH_INTERVAL = 60 * 1000
const CW_MAX_REQUEST_PAYLOAD_BYTES = 1 * 1024 * 1024  // 1MB
const CW_TRUNCATED_SUFFIX = "[Truncated...]"
const CW_EVENT_TIMESTAMP_LIMIT_PAST = 14 * 24 * 60 * 60 * 1000  // 14 days in milliseconds
const CW_EVENT_TIMESTAMP_LIMIT_FUTURE = 2 * 60 * 60 * 1000  // 2 hours in milliseconds

interface Dictionary {
    [key:string]: any
}
interface GroupedMetrics {
    [key:string]: Dictionary
}

interface Record { //[]MetricRecord
    timestamp : number
    attributes : Attributes
    value: RecordValue | number
    instrument: Instrument
}

interface RecordValue {
    [key:string]: number | string | AttributeValue | undefined
};

interface Instrument  {
    name: string,
    unit: string,
    description: string
}


export interface EMFLogInterface {
  "EC2.AutoScalingGroup"?: string
  "Telemetry.Extended"?: string
  Service?: string
  Error?: Error
  Host?: string
  Fault?: Fault
  Operation?: string
  Latency?: Latency
  "K8s.Namespace"?: string
  _aws: Aws
  "K8s.Node"?: string
  "EC2.InstanceId"?: string
  "Telemetry.SDK"?: string
  Environment?: string
  "K8s.WorkLoad"?: string
  "aws.log.group.names"?: string
  PlatformType?: string
  [key:`resource.${string}`]: string
  [metricName:string]: string | Error | Fault | undefined | Aws | RecordValue | number
}

export interface Error {
  Counts: number[]
  Min: number
  Max: number
  Values: number[]
  Sum: number
  Count: number
}

export interface Fault {
  Counts: number[]
  Min: number
  Max: number
  Values: number[]
  Sum: number
  Count: number
}

export interface Latency {
  Counts: number[]
  Min: number
  Max: number
  Values: number[]
  Sum: number
  Count: number
}

export interface Aws {
  CloudWatchMetrics: CloudWatchMetric[]
  Timestamp: number
}

export interface CloudWatchMetric {
  Namespace: string
  Dimensions: string[][]
  Metrics: Metric[]
}

export interface Metric {
  Name: string
  Unit?: string
}



/**
 * Represents an EMF metric data point
 */
class EMFMetricData {
    unit?: string
    timestamp?: number
    values: number[] = [] //List[Union[int, float]] = field(default_factory=list)
    counts: number[] = [] //List[int] = field(default_factory=list)

    public to_dict(): Dictionary {
        return {
            "unit": this.unit,
            "values": this.values,
            "counts": this.counts,
        }
    }
}

// @dataclass
// class EMFLog:
//     /* Represents a complete EMF log entry. */
//     version: str = "0"
//     dimensions: List[List[str]] = field(default_factory=list)
//     metrics: List[Dict[str, Any]] = field(default_factory=list)
//     metadata: Dict[str, Any] = field(default_factory=dict)
//     _aws: Dict[str, Any] = field(default_factory=dict)

//     def to_dict(self) -> Dict:
//         /* Convert EMF log to dictionary format. */
//         result = {
//             "_aws": self._aws,
//             **self.metadata,
//         }
        
//         if self.dimensions:
//             metrics_list = []
//             for metric_dict in self.metrics:
//                 // Convert each metric dict with EMFMetricData to serializable dict
//                 serialized_metric = {}
//                 for metric_name, metric_data in metric_dict.items():
//                     if isinstance(metric_data, EMFMetricData):
//                         serialized_metric[metric_name] = metric_data.to_dict()
//                     else:
//                         serialized_metric[metric_name] = metric_data
//                 metrics_list.append(serialized_metric)
            
//             result["_aws"]["CloudWatchMetrics"] = [{
//                 "Namespace": self._aws.get("Namespace", "default"),
//                 "Dimensions": self.dimensions,
//                 "Metrics": metrics_list,
//             }]
        
//         return result

/**
 * Represents a complete EMF log entry
 */
class EMFLog {
    public version = "0"
    public dimensions: string[][] = []
    public metrics: Dictionary[] = [] //List[Dict[str, Any]] = field(default_factory=list)
    public metadata: Dictionary = {}; //Dict[str, Any] = field(default_factory=dict)
    public _aws: Dictionary = {}; //_aws: Dict[str, Any] = field(default_factory=dict)

    /**
     * Convert EMF log to dictionary format
     * @returns 
     */
    public to_dict(): Dictionary {
        let result = {
            "_aws": this._aws,
            ...this.metadata //[]**this.metadata,
        }
        
        if (this.dimensions) {
            let metrics_list: Dictionary[] = []
            for (const metric_dict of this.metrics) {
                // Convert each metric dict with EMFMetricData to serializable dict
                const serialized_metric: Dictionary = {}
                for (const [metric_name, metric_data] of Object.entries(metric_dict)) {
                    //[] if isinstance(metric_data, EMFMetricData) {
                    if (metric_data instanceof EMFMetricData) {
                        serialized_metric[metric_name] = metric_data.to_dict()
                    } else {
                        serialized_metric[metric_name] = metric_data
                    }
                }
                metrics_list.push(serialized_metric)
            }
            
            result["_aws"]["CloudWatchMetrics"] = [{
                "Namespace": this._aws["Namespace"] || "default",
                "Dimensions": this.dimensions,
                "Metrics": metrics_list,
            }]
        }
        
        return result
    }
}

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format.
 * 
 * This exporter converts OTel metrics into CloudWatch EMF logs which are then
 * sent to CloudWatch Logs. CloudWatch Logs automatically extracts the metrics
 * from the EMF logs.
 */
//[] class CloudWatchEMFExporter(MetricExporter) {
class CloudWatchEMFExporter implements PushMetricExporter {
    private namespace: string
    private log_group_name: string | undefined
    private log_stream_name: string
    private metric_declarations: Dictionary[]
    private parse_json_encoded_attr_values: boolean
    private logs_client: CloudWatchLogsClient

    // OTel to CloudWatch unit mapping
    //[]fix interface
    private UNIT_MAPPING: {[key:string]: string} = {
        "ms": "Milliseconds",
        "s": "Seconds",
        "us": "Microseconds",
        "ns": "Nanoseconds",
        "By": "Bytes",
        "KiBy": "Kilobytes",
        "MiBy": "Megabytes",
        "GiBy": "Gigabytes",
        "TiBy": "Terabytes",
        "Bi": "Bits",
        "KiBi": "Kilobits",
        "MiBi": "Megabits",
        "GiBi": "Gigabits",
        "TiBi": "Terabits",
        "%": "Percent",
        "1": "Count",
        "{count}": "Count",
    }
    
    /**
     * Initialize the CloudWatch EMF exporter.
     * 
     * @param namespace CloudWatch namespace for metrics
     * @param log_group_name CloudWatch log group name
     * @param log_stream_name CloudWatch log stream name (auto-generated if None)
     * @param aws_region AWS region (auto-detected if None)
     * @param metric_declarations Optional metric declarations for filtering
     * @param parse_json_encoded_attr_values Whether to parse JSON-encoded attribute values
     * @param preferred_temporality Optional dictionary mapping instrument types to aggregation temporality
     * @param AggregationTemporality Additional arguments passed to boto3 client
     */
    constructor(
        namespace: string = "default",
        log_group_name: string | undefined,
        log_stream_name: string | undefined,
        aws_region: string | undefined,
        metric_declarations: Dictionary[] | undefined,
        parse_json_encoded_attr_values: boolean = true,
        //[] preferred_temporality: Record<type, AggregationTemporality> | undefined,
        //[] **kwargs
        cloudwatchLogsConfig: CloudWatchLogsClientConfig
    ) {
        //[]super().__init__(preferred_temporality)
        
        this.namespace = namespace
        this.log_group_name = log_group_name
        this.log_stream_name = log_stream_name || this._generate_log_stream_name()
        this.metric_declarations = metric_declarations || []
        this.parse_json_encoded_attr_values = parse_json_encoded_attr_values
        
        // Initialize CloudWatch Logs client
        //[] session = boto3.Session(region_name=aws_region)
        // this.logs_client = session.client("logs", **kwargs)
        this.logs_client = new CloudWatchLogsClient(cloudwatchLogsConfig);
        
        // Ensure log group exists
        this._ensure_log_group_exists()
    }

    private _generate_log_stream_name(): string {
        /* Generate a unique log stream name. */
        // import uuid
        
        // unique_id = str(uuid.uuid4())[:8]
        let unique_id = crypto.randomUUID().substring(0,8)
        return `otel-js-${unique_id}`
    } 

   private async _ensure_log_group_exists() {
        /* Ensure the log group exists, create if it doesn't. */
        try {
            //[] this.logs_client.describe_log_groups(
            //     logGroupNamePrefix=this.log_group_name,
            //     limit=1
            // )
            //[][][][] Should this be non blocking???????
            await this.logs_client.send(new DescribeLogGroupsCommand(
                {
                    logGroupNamePrefix: this.log_group_name,
                    limit: 1
                }
            ))
        } catch(e) {
            try {
                //[] this.logs_client.create_log_group(
                //     logGroupName=this.log_group_name
                // )
                await this.logs_client.send(
                    new CreateLogGroupCommand(
                        {
                            logGroupName: this.log_group_name
                        }
                    )
                )
                diag.info(`Created log group: ${this.log_group_name}`)
            } catch (e) {
                diag.error(`Failed to create log group ${this.log_group_name}: ${e}`)
                throw e;
            }
        }
    } 

   private _get_metric_name(record: Record): string {
        /* Get the metric name from the metric record or data point. */
        // For metrics in MetricsData format
        //[][] if ('name' in record) {
        //[][]     return record.name
        //[][] // For compatibility with older record format
        //[][] } else if ('instrument' in record && 'name' in record.instrument) {
        if (record.instrument?.name) {
            return record.instrument.name
        } else {
            // Fallback with generic name
            return "unknown_metric"
        }
    }
    
    //[][] instrument_or_metric not a good name because is only of type Instrument?
    private _get_unit(instrument_or_metric : Instrument): string | undefined {
        /* Get CloudWatch unit from OTel instrument or metric unit. */
        // Check if we have an Instrument object or a metric with unit attribute
        let unit;
        //[][][Do I really need this?] if (instrument_or_metric instanceof Instrument){
            unit = instrument_or_metric.unit
        //[][] }else{
        //[][]     unit = instrument_or_metric['unit'] ?? undefined
        //[][] }
        if (!unit) {
            return undefined
        }
        return this.UNIT_MAPPING[unit] ?? unit
    }
    
    private _get_dimension_names(attributes: Attributes): string[] {
        /* Extract dimension names from attributes. */
        // Implement dimension selection logic
        // For now, use all attributes as dimensions
        return Object.keys(attributes)
    } 

   private _get_attributes_key(attributes: Attributes): string {
        /*
        Create a hashable key from attributes for grouping metrics.
        
        Args:
            attributes: The attributes dictionary
            
        Returns:
            A string representation of sorted attributes key-value pairs
        */
        // Sort the attributes to ensure consistent keys
        let sorted_attrs = Object.entries(attributes).sort();
        // Create a string representation of the attributes
        return sorted_attrs.toString();
    } 

   private _normalize_timestamp(hrTime: HrTime): number {
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
        return secondsToMillis + nanosToMillis
    
    } 

   private _create_metric_record(metric_name: string, metric_unit: string, metric_description: string) {
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
        

        let record = {
            instrument: {
                name : metric_name,
                unit : metric_unit,
                description : metric_description
            }
        }

        return record
    }


    private _convert_gauge(metric: GaugeMetricData, dp: DataPoint<number>): [Record, number] {
        /*Convert a Gauge metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        
        //[] let timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if 'time_unix_nano' in dp else int(time.time() * 1000)
        let timestamp_ms = this._normalize_timestamp(dp.endTime);
        // Create base record
        let record: Record = {
            ...this._create_metric_record(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
            timestamp: timestamp_ms, // Set timestamp
            attributes: dp.attributes, // Set attributes
            value: dp.value // For Gauge, set the value directly
        }
        
        return [record, timestamp_ms]
   }
    
    private _convert_sum(metric: SumMetricData, dp: DataPoint<number>): [any, number] {
        /*Convert a Sum metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        
        //[] let timestamp_ms = 'time_unix_nano' in dp ? this._normalize_timestamp(dp.time_unix_nano) : parseInt(`${Date.now()}`)
        let timestamp_ms = this._normalize_timestamp(dp.endTime);
        // Create base record
        let record: Record = {
            ...this._create_metric_record(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
            timestamp: timestamp_ms, // Set timestamp
            attributes: dp.attributes, // Set attributes
            value: dp.value // For Sum, set the sum_data
        }
        
        return [record, timestamp_ms]
   }
    

    private _convert_histogram(metric: HistogramMetricData, dp: DataPoint<Histogram>): [Record, number] {
        /*Convert a Histogram metric datapoint to a metric record.

        https://github.com/mircohacker/opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/datapoint.go#L148
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        
        //[] let timestamp_ms = 'time_unix_nano' in dp ? this._normalize_timestamp(dp.time_unix_nano) : parseInt(`${Date.now()}`)
        let timestamp_ms = this._normalize_timestamp(dp.endTime);

        // Create base record
        let record = {
            ...this._create_metric_record(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
            timestamp: timestamp_ms, // Set timestamp
            attributes: dp.attributes, // Set attributes

            //[][] How to handle undefined values like dp.value.sum = undefined?
            value: { // For Histogram, set the histogram_data
                "Count": dp.value.count,
                "Sum": dp.value.sum,
                "Min": dp.value.min,
                "Max": dp.value.max
            }
        }
        
        
        return [record, timestamp_ms]
    }
    
    private _convert_exp_histogram(metric: ExponentialHistogramMetricData, dp: DataPoint<ExponentialHistogram>): [any, number] {
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
        //[] import math
        
        // Set timestamp
        //[] let timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if hasattr(dp, 'time_unix_nano') else int(time.time() * 1000)
        // let timestamp_ms = 'time_unix_nano' in dp ? this._normalize_timestamp(dp.time_unix_nano) : parseInt(`${Date.now()}`)
        let timestamp_ms = this._normalize_timestamp(dp.endTime);
        
        
        // Initialize arrays for values and counts
        let array_values = []
        let array_counts = []
        
        // Get scale
        let scale = dp.value.scale
        // Calculate base using the formula: 2^(2^(-scale))
        let base = Math.pow(2, Math.pow(2, /*//[]float*/(-scale)))
        
        // Process positive buckets
        // if ('positive' in dp && 'bucketCounts' in dp.value.positive && dp.positive.bucket_counts) {
        if (dp.value?.positive?.bucketCounts) {
            let positive_offset = dp.value.positive.offset ?? 0
            let positive_bucket_counts = dp.value.positive.bucketCounts
            
            let bucket_begin = 0
            let bucket_end = 0
            
            for (const [i, count] of positive_bucket_counts.entries()) {
                let index = i + positive_offset
                
                if (bucket_begin == 0) {
                    bucket_begin = Math.pow(base, /*//[]float*/(index))
                } else {
                    bucket_begin = bucket_end
                }
                    
                bucket_end = Math.pow(base, /*//[]float*/(index + 1))
                
                // Calculate midpoint value of the bucket
                let metric_val = (bucket_begin + bucket_end) / 2
                
                // Only include buckets with positive counts
                if (count > 0) {
                    array_values.push(metric_val)
                    array_counts.push(/*//[]float*/(count))
                }
            }
        }

        // Process zero bucket
        let zero_count = dp.value.zeroCount ?? 0
        if (zero_count > 0) {
            array_values.push(0)
            array_counts.push(/*//[]float*/(zero_count))
        }
        
        // Process negative buckets
        //[] if ('negative' in dp && 'bucket_counts' in dp.negative && dp.negative.bucket_counts) {
        if (dp.value?.negative?.bucketCounts) {
            let negative_offset = dp.value.negative.offset ?? 0
            let negative_bucket_counts = dp.value.negative.bucketCounts
            
            let bucket_begin = 0
            let bucket_end = 0
            
            for (const [i, count] of Object.entries(negative_bucket_counts)) {
                let index = parseInt(i) + negative_offset
                
                if (bucket_end == 0) {
                    bucket_end = -Math.pow(base, /*//[]float*/(index))
                } else {
                    bucket_end = bucket_begin
                }
                    
                bucket_begin = -Math.pow(base, /*//[]float*/(index + 1))
                
                // Calculate midpoint value of the bucket
                let metric_val = (bucket_begin + bucket_end) / 2
                
                // Only include buckets with positive counts
                if (count > 0) {
                    array_values.push(metric_val)
                    array_counts.push(/*//[]float*/(count))
                }
            }
        }

        // Create base record
        let record = {
            ...this._create_metric_record(metric.descriptor.name, metric.descriptor.unit, metric.descriptor.description),
            timestamp: timestamp_ms,
            attributes: dp.attributes, // Set attributes

            //[][] How to handle dp.value.sum == undefined?
            value: { // Set the histogram data in the format expected by CloudWatch EMF
                "Values": array_values,
                "Counts": array_counts,
                "Count": dp.value.count,
                "Sum": dp.value.sum,
                "Max": dp.value.max,
                "Min": dp.value.min
            }
        }
        
        return [record, timestamp_ms]
    }
    
    private _group_by_attributes_and_timestamp(record: Record, timestamp_ms: number): [string, number] {
        /*Group metric record by attributes and timestamp.
        
        Args:
            record: The metric record
            timestamp_ms: The timestamp in milliseconds
            
        Returns:
            A tuple key for grouping
        */
        // Create a key for grouping based on attributes
        let attrs_key = this._get_attributes_key(record.attributes)
        return [attrs_key, timestamp_ms]
    } 

    private _create_emf_log(metric_records: Record[], resource: Resource, timestamp: number | undefined = undefined): Dictionary {
        /*
        Create EMF log dictionary from metric records.
        
        Since metric_records is already grouped by attributes, this function
        creates a single EMF log for all records.
        */
        // Start with base structure
        let emf_log: EMFLogInterface = {
            "_aws": {
                "Timestamp": timestamp || parseInt(`${Date.now()}`),
                "CloudWatchMetrics": []
            }
        }
        
        // Add resource attributes to EMF log but not as dimensions
        if (resource && resource.attributes) {
            for (const [key, value] of Object.entries(resource.attributes)) {
                emf_log[`resource.${key}`] = value?.toString() ?? "undefined"; // Python assumes not undefinable
            }
        }
        // Initialize collections for dimensions and metrics
        let all_attributes: Attributes = {}
        let metric_definitions = []
        
        // Process each metric record
        for (const record of metric_records) {
            // Collect attributes from all records (they should be the same for all records in the group)
            if ('attributes' in record && record.attributes) {
                for (const [key, value] of Object.entries(record.attributes)) {
                    all_attributes[key] = value
                }
            }
                    
            let metric_name = this._get_metric_name(record)
            let unit = this._get_unit(record.instrument)
            
            // Create metric data dict
            let metric_data: Dictionary = {}
            if (unit) {
                metric_data["Unit"] = unit
            }

            //[] // TODO - add metric value into record for all kinds of metric type
            emf_log[metric_name] = record.value
            
            // Process different types of aggregations
            if ('histogram_data' in record) {
                // Histogram
                let histogram = record.histogram_data
                if (histogram.count > 0) {
                    let bucket_boundaries = 'bucket_boundaries' in histogram ? list(histogram.bucket_boundaries) : []
                    let bucket_counts = 'bucket_counts' in histogram ? list(histogram.bucket_counts) : []

                    // Format for CloudWatch EMF histogram format
                    emf_log[metric_name] = {
                        "Values": bucket_boundaries,
                        "Counts": bucket_counts,
                        "Max": 0,
                        "Min": 0,
                        "Count": 1,
                        "Sum": 0
                    }
                }
            } else if ('sum_data' in record) {
                // Counter/UpDownCounter
                let sum_data = record.sum_data
                // Store value directly in emf_log
                emf_log[metric_name] = sum_data.value
            } else {
                // Other aggregations (e.g., LastValue)
                if ('value' in record) {
                    // Store value directly in emf_log
                    emf_log[metric_name] = record.value
                }
            }
            // Add to metric definitions list
            metric_definitions.push({
                "Name": metric_name,
                ...metric_data
            })
        }
        // Get dimension names from collected attributes
        let dimension_names = this._get_dimension_names(all_attributes)
        
        // Add attribute values to the root of the EMF log
        for (const [name, value] of Object.entries(all_attributes)) {
            emf_log[name] = value?.toString() ?? "undefined"
        }
        
        // Add the single dimension set to CloudWatch Metrics if we have dimensions and metrics
        if (dimension_names && metric_definitions) {
            emf_log["_aws"]["CloudWatchMetrics"].push({
                "Namespace": this.namespace,
                "Dimensions": [dimension_names],
                "Metrics": metric_definitions
            })
        }
        
        return emf_log
    }
    
    //[] public export(metrics_data: MetricsData, timeout_millis: number | undefined, **kwargs): MetricExportResult {
    public export(metrics_data: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
        /*
        Export metrics as EMF logs to CloudWatch.
        
        Groups metrics by attributes and timestamp before creating EMF logs.
        
        Args:
            metrics_data: MetricsData containing resource metrics and scope metrics
            timeout_millis: Optional timeout in milliseconds
            **kwargs: Additional keyword arguments
            
        Returns:
            MetricExportResult indicating success or failure
        */
        try {
            // Import metric data types within the method to avoid circular imports
            //[] from opentelemetry.sdk.metrics.export import (
            //     Gauge, Sum, Histogram, ExponentialHistogram
            // )
            
            //[][] if (!metrics_data.resource_metrics) {
            //     return MetricExportResult.SUCCESS
            // }
            if (!metrics_data.scopeMetrics) {
                resultCallback({code: ExportResultCode.SUCCESS})
                return
            }
            
            // Process all metrics from all resource metrics and scope metrics
            //[][]for (resource_metrics in metrics_data.resource_metrics) {
                // The resource is now part of each resource_metrics object
                //[][]let resource = resource_metrics.resource
                let resource = metrics_data.resource;
                
                for (const scope_metrics of metrics_data.scopeMetrics/*resource_metrics.scope_metrics*/) {
                    // Dictionary to group metrics by attributes and timestamp
                    // Key: (attributes_key, timestamp_ms)
                    // Value: list of metric records
                    let grouped_metrics: GroupedMetrics = {}//[]defaultdict(list)
                    
                    // Process all metrics in this scope
                    for (const metric of scope_metrics.metrics) {
                        // Convert metrics to a format compatible with _create_emf_log
                        // Access data points through metric.data.data_points
                        // if ('data' in metric && 'data_points' in metric.data) {
                        if ('dataPoints' in metric) {
                            // Process different metric types
                            if (metric.dataPointType == DataPointType.GAUGE) {
                                //[]for (const dp of metric.data.data_points){
                                for (const dp of metric.dataPoints){
                                    const [record, timestamp_ms] = this._convert_gauge(metric, dp)
                                    let [groupAttribute, groupTimestamp] = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[groupAttribute][groupTimestamp] = []
                                    grouped_metrics[groupAttribute][groupTimestamp].push(record)
                                }
                                    
                            } else if (metric.dataPointType == DataPointType.SUM) {
                                for (const dp of metric.dataPoints){
                                    const [record, timestamp_ms] = this._convert_sum(metric, dp)
                                    let [groupAttribute, groupTimestamp] = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[groupAttribute][groupTimestamp] = []
                                    grouped_metrics[groupAttribute][groupTimestamp].push(record)
                                }
                            } else if (metric.dataPointType == DataPointType.HISTOGRAM) {
                                for (const dp of metric.dataPoints) {
                                    const [record, timestamp_ms] = this._convert_histogram(metric, dp)
                                    let [groupAttribute, groupTimestamp] = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[groupAttribute][groupTimestamp] = []
                                    grouped_metrics[groupAttribute][groupTimestamp].push(record)
                                }
                            } else if (metric.dataPointType == DataPointType.EXPONENTIAL_HISTOGRAM) {
                                for (const dp of metric.dataPoints) {
                                    const [record, timestamp_ms] = this._convert_exp_histogram(metric, dp)
                                    let [groupAttribute, groupTimestamp] = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[groupAttribute][groupTimestamp] = []
                                    grouped_metrics[groupAttribute][groupTimestamp].push(record)
                                }
                            } else {
                                diag.warn("Unsupported Metric Type: %s", (metric as any).dataPointType)
                                continue  // Skip this metric but continue processing others
                            }
                        }
                    }
                    
                    // Now process each group separately to create one EMF log per group
                    //[]for ((attrs_key, timestamp_ms), metric_records in grouped_metrics.items()) {
                    for (const attrs_key of Object.keys(grouped_metrics)) {
                        for (const timestamp_ms of Object.keys(grouped_metrics[attrs_key])) {
                            const metric_records = grouped_metrics[attrs_key][timestamp_ms];
                            if (metric_records) {
                                diag.debug(`Creating EMF log for group with ${metric_records.length} metrics.
                                            Timestamp: ${timestamp_ms}, Attributes: ${attrs_key.substring(0,100)}...`)
                                
                                // Create EMF log for this batch of metrics with the group's timestamp
                                let emf_log_dict = this._create_emf_log(metric_records, resource, Number(timestamp_ms))
                                
                                // Convert to JSON
                                let log_event = {
                                    "message": emf_log_dict,//[]json.dumps(emf_log_dict),
                                    "timestamp": timestamp_ms
                                }
                                
                                // Send to CloudWatch Logs
                                this._send_log_event(log_event)
                            }
                        }
                    }
                }
            // }

            //[] return MetricExportResult.SUCCESS
            resultCallback({code: ExportResultCode.SUCCESS})
            return;
        } catch(e) {
            diag.error(`Failed to export metrics: ${e}`)
            //[] import traceback
            //[] diag.error(traceback.format_exc())
            //[]return MetricExportResult.FAILURE
            resultCallback({code: ExportResultCode.FAILED, error: (e as Error)})
            return;
        }
    }


    private _validate_log_event(log_event: Dictionary): boolean {
        /*
        Validate the log event according to CloudWatch Logs constraints.
        Implements the same validation logic as the Go version.
        
        Args:
            log_event: The log event to validate
            
        Returns:
            bool: true if valid, false otherwise
        */
        let message = log_event.get("message", "")
        let timestamp = log_event.get("timestamp", 0)
        
        // Check message size
        let message_size = message.length + CW_PER_EVENT_HEADER_BYTES
        if (message_size > CW_MAX_EVENT_PAYLOAD_BYTES) {
            diag.warn(`Log event size ${message_size} exceeds maximum allowed size {CW_MAX_EVENT_PAYLOAD_BYTES}. Truncating.`)
            let max_message_size = CW_MAX_EVENT_PAYLOAD_BYTES - CW_PER_EVENT_HEADER_BYTES - CW_TRUNCATED_SUFFIX.length
            log_event["message"] = message.substring(0, max_message_size) + CW_TRUNCATED_SUFFIX//[]message[:max_message_size] + CW_TRUNCATED_SUFFIX
        }
        
        // Check empty message
        if (!log_event.get("message")) {
            diag.error("Empty log event message")
            return false
        }
        
        // Check timestamp constraints
        let current_time = parseInt(`${Date.now()}`)  // Current time in milliseconds
        let event_time = timestamp
        
        // Calculate the time difference
        let time_diff = current_time - event_time
        
        // Check if too old or too far in the future
        if (time_diff > CW_EVENT_TIMESTAMP_LIMIT_PAST || time_diff < -CW_EVENT_TIMESTAMP_LIMIT_FUTURE) {
            diag.error(
                `Log event timestamp ${event_time} is either older than 14 days or more than 2 hours in the future.
                Current time: ${current_time}`
            )
            return false
        }
        
        return true
    
    } 

    private _create_event_batch(): Dictionary {
        /*
        Create a new log event batch.
        
        Returns:
            Dict: A new event batch
        */
        return {
            "logEvents": [],
            "byteTotal": 0,
            "minTimestampMs": 0,
            "maxTimestampMs": 0,
            "createdTimestampMs": parseInt(`${Date.now()}`)
        }
    
    } 

    private _event_batch_exceeds_limit(batch: Dictionary, next_event_size: number): boolean {
        /*
        Check if adding the next event would exceed CloudWatch Logs limits.
        
        Args:
            batch: The current batch
            next_event_size: Size of the next event in bytes CW_MAX_REQUEST_EVENT_COUNT
            
        Returns:
            bool: true if adding the next event would exceed limits
        */
        return (
            batch["logEvents"].length >= CW_MAX_REQUEST_EVENT_COUNT ||
            batch["byteTotal"] + next_event_size > CW_MAX_REQUEST_PAYLOAD_BYTES
        )
    
    } 

    private _is_batch_active(batch: Dictionary, target_timestamp_ms: number): boolean {
        /*
        Check if the event batch spans more than 24 hours.
        
        Args:
            batch: The event batch
            target_timestamp_ms: The timestamp of the event to add
            
        Returns:
            bool: true if the batch is active and can accept the event
        */
        // New log event batch
        if (batch["minTimestampMs"] == 0 || batch["maxTimestampMs"] == 0) {
            return true
        }
        
        // Check if adding the event would make the batch span more than 24 hours
        if (target_timestamp_ms - batch["minTimestampMs"] > 24 * 3600 * 1000) {
            return false
        }
        
        if (batch["maxTimestampMs"] - target_timestamp_ms > 24 * 3600 * 1000) {
            return false
        }
        
        // flush the event batch when reached 60s interval
        let current_time = parseInt(`${Date.now()}`)
        if (current_time - batch["createdTimestampMs"] >= BATCH_FLUSH_INTERVAL) {
            return false
        }
        
        return true
    
    } 

    private _append_to_batch(batch: Dictionary, log_event: Dictionary, event_size: number) {
        /*
        Append a log event to the batch.
        
        Args:
            batch: The event batch
            log_event: The log event to append
            event_size: Size of the event in bytes
        */
        batch["logEvents"].push(log_event)
        batch["byteTotal"] += event_size
        
        let timestamp = log_event["timestamp"]
        if (batch["minTimestampMs"] == 0 || batch["minTimestampMs"] > timestamp) {
            batch["minTimestampMs"] = timestamp
        }
        
        if (batch["maxTimestampMs"] == 0 || batch["maxTimestampMs"] < timestamp) {
            batch["maxTimestampMs"] = timestamp
        }
    
    } 

    private _sort_log_events(batch: Dictionary) {
        /*
        Sort log events in the batch by timestamp.
        
        Args:
            batch: The event batch
        */
        //[]batch["logEvents"] = sorted(batch["logEvents"], key=lambda x: x["timestamp"])
        batch.logEvents = batch.logEvents.sort((a: number, b) => a.timestamp - b.timestamp);
    } 

    private async _send_log_batch(batch: Dictionary) {
        /*
        Send a batch of log events to CloudWatch Logs.
        
        Args:
            batch: The event batch
        */
        if (!batch["logEvents"]) {
            return
        }

        // Sort log events by timestamp
        this._sort_log_events(batch)
        
        // Prepare the PutLogEvents request
        let put_log_events_input: any = {
            //[] "logGroupName": this.log_group_name,
            "logStreamName": this.log_stream_name,
            "logEvents": batch["logEvents"]
        }
        if (this.log_group_name) {
            put_log_events_input["logGroupName"] = this.log_group_name;
        }
        
        // let start_time = time.time()
        let start_time = Date.now();
        
        try {
            // Create log group and stream if they don't exist
            try {
                //[] this.logs_client.create_log_group(
                //     logGroupName=this.log_group_name
                // )

                await this.logs_client.send(
                    new CreateLogGroupCommand(
                        {
                            logGroupName: this.log_group_name
                        }
                    )
                )


                diag.info(`Created log group: ${this.log_group_name}`)
            } catch(e) { //[]except this.logs_client.exceptions.ResourceAlreadyExistsException:
                // Log group already exists, this is fine
                diag.debug(`Log group ${this.log_group_name} already exists`)
            }
            
            // Create log stream if it doesn't exist
            try {
                //[] this.logs_client.create_log_stream(
                //     logGroupName=this.log_group_name,
                //     logStreamName=this.log_stream_name
                // )
                await this.logs_client.send(
                    new CreateLogStreamCommand(
                        {
                            logGroupName: this.log_group_name,
                            logStreamName: this.log_stream_name
                        }
                    )
                )

                diag.info(`Created log stream: ${this.log_stream_name}`)
            } catch(e) { //except this.logs_client.exceptions.ResourceAlreadyExistsException:
                // Log stream already exists, this is fine
                diag.debug(`Log stream ${this.log_stream_name} already exists`)
            }
            
            // Make the PutLogEvents call
            //[] let response = this.logs_client.put_log_events(**put_log_events_input)
            let response = await this.logs_client.send(new PutLogEventsCommand(
                put_log_events_input
            ))
            
            let elapsed_ms = parseInt(`${Date.now() - start_time}`)
            diag.debug(
                `Successfully sent ${batch['logEvents'].length} log events
                (${(batch['byteTotal'] / 1024).toFixed(2)} KB) in ${elapsed_ms} ms`
            )
            
            return response
            
        } catch(e) {
            diag.error(`Failed to send log events: ${e}`)
            //[] import traceback
            //[] diag.error(traceback.format_exc())
            throw e
        }
    }
    
    // Event batch to store logs before sending to CloudWatch
    private _event_batch: undefined | Dictionary = undefined;//[]None
    
    private _send_log_event(log_event: Dictionary) {
        /*
        Send a log event to CloudWatch Logs.
        
        This function implements the same logic as the Go version in the OTel Collector.
        It batches log events according to CloudWatch Logs constraints and sends them
        when the batch is full or spans more than 24 hours.
        
        Args:
            log_event: The log event to send
        */
        try {
            // Validate the log event
            if (!this._validate_log_event(log_event)) {
                return
            }
            
            // Calculate event size
            let event_size = log_event["message"].length + CW_PER_EVENT_HEADER_BYTES
            
            // Initialize event batch if needed
            if (this._event_batch == undefined) {
                this._event_batch = this._create_event_batch()
            }
            
            // Check if we need to send the current batch and create a new one
            let current_batch = this._event_batch
            if ((this._event_batch_exceeds_limit(current_batch, event_size) || !this._is_batch_active(current_batch, log_event["timestamp"]))) {
                // Send the current batch
                this._send_log_batch(current_batch)
                // Create a new batch
                this._event_batch = this._create_event_batch()
                current_batch = this._event_batch
            }
            
            // Add the log event to the batch
            this._append_to_batch(current_batch, log_event, event_size)
            
        } catch(e) {
            diag.error(`Failed to process log event: ${e}`)
            //[] import traceback
            //[] diag.error(traceback.format_exc())
            throw e
        }
    }
    
    public forceFlush(timeout_millis: number = 10000) {
        /*
        Force flush any pending metrics.
        
        Args:
            timeout_millis: Timeout in milliseconds
            
        Returns:
            true if successful, false otherwise
        */
        if (this._event_batch !== undefined && this._event_batch["logEvents"].length > 0) {
            let current_batch = this._event_batch
            this._send_log_batch(current_batch)
            this._event_batch = this._create_event_batch()
        }
        diag.debug("CloudWatchEMFExporter force flushes the bufferred metrics")
        return Promise.resolve();
    }
    
    public shutdown(/*//[]timeout_millis=undefined, **kwargs*/) {
        /*
        Shutdown the exporter.
        Override to handle timeout and other keyword arguments, but do nothing.
        
        Args:
            timeout_millis: Ignored timeout in milliseconds
            **kwargs: Ignored additional keyword arguments
        */
        // Intentionally do nothing
        this.forceFlush(/*//[]timeout_millis*/)
        diag.debug(`CloudWatchEMFExporter shutdown called`)
        return Promise.resolve();
    }
}
