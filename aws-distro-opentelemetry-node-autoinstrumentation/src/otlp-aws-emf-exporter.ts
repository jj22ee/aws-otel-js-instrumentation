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
  diag,
  DiagLogLevel,
} from '@opentelemetry/api';
import { CloudWatchLogsClient, CloudWatchLogsClientConfig } from '@aws-sdk/client-cloudwatch-logs'
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';

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

interface dictionary {
    [key:string]: any
}

/**
 * Represents an EMF metric data point
 */
class EMFMetricData {
    unit?: string
    timestamp?: number
    values: number[] = [] //List[Union[int, float]] = field(default_factory=list)
    counts: number[] = [] //List[int] = field(default_factory=list)

    public to_dict(): dictionary {
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
    private const version = "0"
    private const dimensions: string[][] = []
    private const metrics: dictionary[] = [] //List[Dict[str, Any]] = field(default_factory=list)
    private const metadata: dictionary = {}; //Dict[str, Any] = field(default_factory=dict)
    private const _aws: dictionary = {}; //_aws: Dict[str, Any] = field(default_factory=dict)

    /**
     * Convert EMF log to dictionary format
     * @returns 
     */
    public to_dict(): dictionary {
        let result = {
            "_aws": this._aws,
            ...this.metadata //[]**this.metadata,
        }
        
        if (this.dimensions) {
            let metrics_list: dictionary[] = []
            for (const metric_dict of this.metrics) {
                // Convert each metric dict with EMFMetricData to serializable dict
                const serialized_metric: dictionary = {}
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
    private metric_declarations: Record<string, any>[]
    private parse_json_encoded_attr_values: boolean
    private session: CloudWatchLogsClient

    // OTel to CloudWatch unit mapping
    private const UNIT_MAPPING = {
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
        metric_declarations: Record<string, any>[] | undefined,
        parse_json_encoded_attr_values: boolean = true,
        preferred_temporality: Record<type, AggregationTemporality> | undefined,
        // **kwargs
        cloudwatchLogsConfig: CloudWatchLogsClientConfig
    ) {
        super().__init__(preferred_temporality)
        
        this.namespace = namespace
        this.log_group_name = log_group_name
        this.log_stream_name = log_stream_name || this._generate_log_stream_name()
        this.metric_declarations = metric_declarations || []
        this.parse_json_encoded_attr_values = parse_json_encoded_attr_values
        
        // Initialize CloudWatch Logs client
        //[] session = boto3.Session(region_name=aws_region)
        // this.logs_client = session.client("logs", **kwargs)
        this.session = new CloudWatchLogsClient(cloudwatchLogsConfig);
        
        // Ensure log group exists
        this._ensure_log_group_exists()
    }

    private generate_log_stream_name(): string {
        /* Generate a unique log stream name. */
        // import uuid
        
        // unique_id = str(uuid.uuid4())[:8]
        let unique_id = crypto.randomUUID().substring(0,8)
        return `otel-js-${unique_id}`
    } 

   private ensure_log_group_exists() {
        /* Ensure the log group exists, create if it doesn't. */
        try {
            this.logs_client.describe_log_groups(
                logGroupNamePrefix=this.log_group_name,
                limit=1
            )
        } catch(e) {
            try {
                this.logs_client.create_log_group(
                    logGroupName=this.log_group_name
                )
                diag.info(f"Created log group: {this.log_group_name}")
            } catch (e) {
                diag.error(f"Failed to create log group {this.log_group_name}: {e}")
                throw e;
            }
        }
    } 

   private get_metric_name(record): string {
        /* Get the metric name from the metric record or data point. */
        // For metrics in MetricsData format
        if hasattr(record, 'name') {
            return record.name
        // For compatibility with older record format
        } else if hasattr(record, 'instrument') and hasattr(record.instrument, 'name') {
            return record.instrument.name
        } else {
            // Fallback with generic name
            return "unknown_metric"
        }
    }
    
    private get_unit(instrument_or_metric): string | undefined {
        /* Get CloudWatch unit from OTel instrument or metric unit. */
        // Check if we have an Instrument object or a metric with unit attribute
        if isinstance(instrument_or_metric, Instrument){
            unit = instrument_or_metric.unit
        }else{
            unit = getattr(instrument_or_metric, 'unit', None)
            
        }if not unit{
            return None
        }
        return this.UNIT_MAPPING.get(unit, unit)
    }
    
    private get_dimension_names(attributes: Attributes): string[] {
        /* Extract dimension names from attributes. */
        // Implement dimension selection logic
        // For now, use all attributes as dimensions
        return Object.keys(attributes)
    } 

   private get_attributes_key(attributes: Attributes): string {
        /*
        Create a hashable key from attributes for grouping metrics.
        
        Args:
            attributes: The attributes dictionary
            
        Returns:
            A string representation of sorted attributes key-value pairs
        */
        // Sort the attributes to ensure consistent keys
        sorted_attrs = sorted(attributes.items())
        // Create a string representation of the attributes
        return str(sorted_attrs)
    
    } 

   private _normalize_timestamp(timestamp_ns: number): number {
        /*
        Normalize a nanosecond timestamp to milliseconds for CloudWatch.
        
        Args:
            timestamp_ns: Timestamp in nanoseconds
            
        Returns:
            Timestamp in milliseconds
        */
        // Convert from nanoseconds to milliseconds
        return timestamp_ns // 1_000_000
    
    } 

   private create_metric_record(metric_name: str, metric_unit: str, metric_description: str): Any {
        /*Create a base metric record with instrument information.
        
        Args:
            metric_name: Name of the metric
            metric_unit: Unit of the metric
            metric_description: Description of the metric
            
        Returns:
            A base metric record object
        */
        record = type('MetricRecord', (), {})()
        record.instrument = type('Instrument', (), {})()
        record.instrument.name = metric_name
        record.instrument.unit = metric_unit
        record.instrument.description = metric_description
        
        return record
   }
    
    private convert_gauge(metric, dp): Tuple[Any, number] {
        /*Convert a Gauge metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        // Create base record
        record = this._create_metric_record(metric.name, metric.unit, metric.description)
        
        // Set timestamp
        timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if hasattr(dp, 'time_unix_nano') else int(time.time() * 1000)
        record.timestamp = timestamp_ms

        // Set attributes
        record.attributes = dp.attributes
        
        // For Gauge, set the value directly
        record.value = dp.value
        
        return record, timestamp_ms
   }
    
    private _convert_sum(metric, dp): Tuple[Any, number] {
        /*Convert a Sum metric datapoint to a metric record.
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        // Create base record
        record = this._create_metric_record(metric.name, metric.unit, metric.description)
        
        // Set timestamp
        timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if hasattr(dp, 'time_unix_nano') else int(time.time() * 1000)
        record.timestamp = timestamp_ms

        // Set attributes
        record.attributes = dp.attributes
        
        // For Sum, set the sum_data
        record.value = dp.value
        
        return record, timestamp_ms
   }
    

    private _convert_histogram(metric, dp): Tuple[Any, number] {
        /*Convert a Histogram metric datapoint to a metric record.

        https://github.com/mircohacker/opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/datapoint.go#L148
        
        Args:
            metric: The metric object
            dp: The datapoint to convert
            
        Returns:
            Tuple of (metric record, timestamp in ms)
        */
        // Create base record
        record = this._create_metric_record(metric.name, metric.unit, metric.description)
        
        // Set timestamp
        timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if hasattr(dp, 'time_unix_nano') else int(time.time() * 1000)
        record.timestamp = timestamp_ms
        
        // Set attributes
        record.attributes = dp.attributes
        
        // For Histogram, set the histogram_data
        record.value = {
            "Count": dp.count,
            "Sum": dp.sum,
            "Min": dp.min,
            "Max": dp.max
        }
        
        return record, timestamp_ms
    }
    
    private convert_exp_histogram(metric, dp): Tuple[Any, number] {
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
        import math
        
        // Create base record
        record = this._create_metric_record(metric.name, metric.unit, metric.description)
        
        // Set timestamp
        timestamp_ms = this._normalize_timestamp(dp.time_unix_nano) if hasattr(dp, 'time_unix_nano') else int(time.time() * 1000)
        record.timestamp = timestamp_ms
        
        // Set attributes
        record.attributes = dp.attributes
        
        // Initialize arrays for values and counts
        array_values = []
        array_counts = []
        
        // Get scale
        scale = dp.scale
        // Calculate base using the formula: 2^(2^(-scale))
        base = math.pow(2, math.pow(2, float(-scale)))
        
        // Process positive buckets
        if (hasattr(dp, 'positive') and hasattr(dp.positive, 'bucket_counts') and dp.positive.bucket_counts) {
            positive_offset = getattr(dp.positive, 'offset', 0)
            positive_bucket_counts = dp.positive.bucket_counts
            
            bucket_begin = 0
            bucket_end = 0
            
            for (i, count in enumerate(positive_bucket_counts)) {
                index = i + positive_offset
                
                if (bucket_begin == 0) {
                    bucket_begin = math.pow(base, float(index))
                } else {
                    bucket_begin = bucket_end
                }
                    
                bucket_end = math.pow(base, float(index + 1))
                
                // Calculate midpoint value of the bucket
                metric_val = (bucket_begin + bucket_end) / 2
                
                // Only include buckets with positive counts
                if (count > 0) {
                    array_values.append(metric_val)
                    array_counts.append(float(count))
                }
            }
        }

        // Process zero bucket
        zero_count = getattr(dp, 'zero_count', 0)
        if (zero_count > 0) {
            array_values.append(0)
            array_counts.append(float(zero_count))
        }
        
        // Process negative buckets
        if (hasattr(dp, 'negative') and hasattr(dp.negative, 'bucket_counts') and dp.negative.bucket_counts) {
            negative_offset = getattr(dp.negative, 'offset', 0)
            negative_bucket_counts = dp.negative.bucket_counts
            
            bucket_begin = 0
            bucket_end = 0
            
            for (i, count in enumerate(negative_bucket_counts)) {
                index = i + negative_offset
                
                if (bucket_end == 0) {
                    bucket_end = -math.pow(base, float(index))
                } else {
                    bucket_end = bucket_begin
                }
                    
                bucket_begin = -math.pow(base, float(index + 1))
                
                // Calculate midpoint value of the bucket
                metric_val = (bucket_begin + bucket_end) / 2
                
                // Only include buckets with positive counts
                if (count > 0) {
                    array_values.append(metric_val)
                    array_counts.append(float(count))
                }
            }
        }

        // Set the histogram data in the format expected by CloudWatch EMF
        record.value = {
            "Values": array_values,
            "Counts": array_counts,
            "Count": dp.count,
            "Sum": dp.sum,
            "Max": dp.max,
            "Min": dp.min
        }
        
        return record, timestamp_ms
    }
    
    private group_by_attributes_and_timestamp(record, timestamp_ms): Tuple[str, number] {
        /*Group metric record by attributes and timestamp.
        
        Args:
            record: The metric record
            timestamp_ms: The timestamp in milliseconds
            
        Returns:
            A tuple key for grouping
        */
        // Create a key for grouping based on attributes
        attrs_key = this._get_attributes_key(record.attributes)
        return (attrs_key, timestamp_ms)
    } 

    private create_emf_log(metric_records, resource: Resource, timestamp: Optional[number] = None): Dict {
        /*
        Create EMF log dictionary from metric records.
        
        Since metric_records is already grouped by attributes, this function
        creates a single EMF log for all records.
        */
        // Start with base structure
        emf_log = {
            "_aws": {
                "Timestamp": timestamp or int(time.time() * 1000),
                "CloudWatchMetrics": []
            }
        }
        
        // Add resource attributes to EMF log but not as dimensions
        if (resource and resource.attributes) {
            for (key, value in resource.attributes.items()) {
                emf_log[f"resource.{key}"] = str(value)
            }
        }
        // Initialize collections for dimensions and metrics
        all_attributes = {}
        metric_definitions = []
        
        // Process each metric record
        for (record in metric_records) {
            // Collect attributes from all records (they should be the same for all records in the group)
            if (hasattr(record, 'attributes') and record.attributes) {
                for (key, value in record.attributes.items()) {
                    all_attributes[key] = value
                }
            }
                    
            metric_name = this._get_metric_name(record)
            unit = this._get_unit(record.instrument)
            
            // Create metric data dict
            metric_data = {}
            if (unit) {
                metric_data["Unit"] = unit
            }

            //[] // TODO - add metric value into record for all kinds of metric type
            emf_log[metric_name] = record.value
            
            // Process different types of aggregations
            if (hasattr(record, 'histogram_data')) {
                // Histogram
                histogram = record.histogram_data
                if (histogram.count > 0) {
                    bucket_boundaries = list(histogram.bucket_boundaries) if hasattr(histogram, 'bucket_boundaries') else []
                    bucket_counts = list(histogram.bucket_counts) if hasattr(histogram, 'bucket_counts') else []
                    
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
            } else if (hasattr(record, 'sum_data')) {
                // Counter/UpDownCounter
                sum_data = record.sum_data
                // Store value directly in emf_log
                emf_log[metric_name] = sum_data.value
            } else {
                // Other aggregations (e.g., LastValue)
                if (hasattr(record, 'value')) {
                    // Store value directly in emf_log
                    emf_log[metric_name] = record.value
                }
            }
            // Add to metric definitions list
            metric_definitions.append({
                "Name": metric_name,
                **metric_data
            })
        }
        // Get dimension names from collected attributes
        dimension_names = this._get_dimension_names(all_attributes)
        
        // Add attribute values to the root of the EMF log
        for (name, value in all_attributes.items()) {
            emf_log[name] = str(value)
        }
        
        // Add the single dimension set to CloudWatch Metrics if we have dimensions and metrics
        if (dimension_names and metric_definitions) {
            emf_log["_aws"]["CloudWatchMetrics"].append({
                "Namespace": this.namespace,
                "Dimensions": [dimension_names],
                "Metrics": metric_definitions
            })
        }
        
        return emf_log
    }
    
    public export(metrics_data: MetricsData, timeout_millis: Optional[number] = None, **kwargs): MetricExportResult {
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
            from opentelemetry.sdk.metrics.export import (
                Gauge, Sum, Histogram, ExponentialHistogram
            )
            
            if (not metrics_data.resource_metrics) {
                return MetricExportResult.SUCCESS
            }
            
            // Process all metrics from all resource metrics and scope metrics
            for (resource_metrics in metrics_data.resource_metrics) {
                // The resource is now part of each resource_metrics object
                resource = resource_metrics.resource
                
                for (scope_metrics in resource_metrics.scope_metrics) {
                    // Dictionary to group metrics by attributes and timestamp
                    // Key: (attributes_key, timestamp_ms)
                    // Value: list of metric records
                    grouped_metrics = defaultdict(list)
                    
                    // Process all metrics in this scope
                    for (metric in scope_metrics.metrics) {
                        // Convert metrics to a format compatible with _create_emf_log
                        // Access data points through metric.data.data_points
                        if (hasattr(metric, 'data') and hasattr(metric.data, 'data_points')) {
                            // Process different metric types
                            if (isinstance(metric.data, Gauge)) {
                                for (dp in metric.data.data_points){
                                    record, timestamp_ms = this._convert_gauge(metric, dp)
                                    group_key = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[group_key].append(record)
                                }
                                    
                            } else if (isinstance(metric.data, Sum)) {
                                for (dp in metric.data.data_points){
                                    record, timestamp_ms = this._convert_sum(metric, dp)
                                    group_key = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[group_key].append(record)
                                }
                            } else if (isinstance(metric.data, Histogram)) {
                                for (dp in metric.data.data_points) {
                                    record, timestamp_ms = this._convert_histogram(metric, dp)
                                    group_key = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[group_key].append(record)
                                }
                            } else if (isinstance(metric.data, ExponentialHistogram)) {
                                for (dp in metric.data.data_points) {
                                    record, timestamp_ms = this._convert_exp_histogram(metric, dp)
                                    group_key = this._group_by_attributes_and_timestamp(record, timestamp_ms)
                                    grouped_metrics[group_key].append(record)
                                }
                            } else {
                                diag.warning("Unsupported Metric Type: %s", type(metric.data))
                                continue  // Skip this metric but continue processing others
                            }
                        }
                    }
                    
                    // Now process each group separately to create one EMF log per group
                    for ((attrs_key, timestamp_ms), metric_records in grouped_metrics.items()) {
                        if (metric_records) {
                            diag.debug(f"Creating EMF log for group with {len(metric_records)} metrics. "
                                        f"Timestamp: {timestamp_ms}, Attributes: {attrs_key[:100]}...")
                            
                            // Create EMF log for this batch of metrics with the group's timestamp
                            emf_log_dict = this._create_emf_log(metric_records, resource, timestamp_ms)
                            
                            // Convert to JSON
                            log_event = {
                                "message": json.dumps(emf_log_dict),
                                "timestamp": timestamp_ms
                            }
                            
                            // Send to CloudWatch Logs
                            this._send_log_event(log_event)
                        }
                    }
                }
            }
            return MetricExportResult.SUCCESS
            
        } catch(e) {
            diag.error(f"Failed to export metrics: {e}")
            import traceback
            diag.error(traceback.format_exc())
            return MetricExportResult.FAILURE
        }
    }


    private validate_log_event(log_event: Dict): bool {
        /*
        Validate the log event according to CloudWatch Logs constraints.
        Implements the same validation logic as the Go version.
        
        Args:
            log_event: The log event to validate
            
        Returns:
            bool: true if valid, false otherwise
        */
        message = log_event.get("message", "")
        timestamp = log_event.get("timestamp", 0)
        
        // Check message size
        message_size = len(message) + CW_PER_EVENT_HEADER_BYTES
        if (message_size > CW_MAX_EVENT_PAYLOAD_BYTES) {
            diag.warning(
                f"Log event size {message_size} exceeds maximum allowed size {CW_MAX_EVENT_PAYLOAD_BYTES}. Truncating."
            )
            max_message_size = CW_MAX_EVENT_PAYLOAD_BYTES - CW_PER_EVENT_HEADER_BYTES - len(CW_TRUNCATED_SUFFIX)
            log_event["message"] = message[:max_message_size] + CW_TRUNCATED_SUFFIX
        }
        
        // Check empty message
        if (not log_event.get("message")) {
            diag.error("Empty log event message")
            return false
        }
        
        // Check timestamp constraints
        current_time = int(time.time() * 1000)  // Current time in milliseconds
        event_time = timestamp
        
        // Calculate the time difference
        time_diff = current_time - event_time
        
        // Check if too old or too far in the future
        if (time_diff > CW_EVENT_TIMESTAMP_LIMIT_PAST or time_diff < -CW_EVENT_TIMESTAMP_LIMIT_FUTURE) {
            diag.error(
                f"Log event timestamp {event_time} is either older than 14 days or more than 2 hours in the future. "
                f"Current time: {current_time}"
            )
            return false
        }
        
        return true
    
    } 

    private create_event_batch(): Dict {
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
            "createdTimestampMs": int(time.time() * 1000)
        }
    
    } 

    private event_batch_exceeds_limit(batch: Dict, next_event_size: number): bool {
        /*
        Check if adding the next event would exceed CloudWatch Logs limits.
        
        Args:
            batch: The current batch
            next_event_size: Size of the next event in bytes CW_MAX_REQUEST_EVENT_COUNT
            
        Returns:
            bool: true if adding the next event would exceed limits
        */
        return (
            len(batch["logEvents"]) >= CW_MAX_REQUEST_EVENT_COUNT or
            batch["byteTotal"] + next_event_size > CW_MAX_REQUEST_PAYLOAD_BYTES
        )
    
    } 

    private is_batch_active(batch: Dict, target_timestamp_ms: number): bool {
        /*
        Check if the event batch spans more than 24 hours.
        
        Args:
            batch: The event batch
            target_timestamp_ms: The timestamp of the event to add
            
        Returns:
            bool: true if the batch is active and can accept the event
        */
        // New log event batch
        if (batch["minTimestampMs"] == 0 or batch["maxTimestampMs"] == 0) {
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
        current_time = int(time.time() * 1000)
        if (current_time - batch["createdTimestampMs"] >= BATCH_FLUSH_INTERVAL) {
            return false
        }
        
        return true
    
    } 

    private append_to_batch(batch: Dict, log_event: Dict, event_size: number): None {
        /*
        Append a log event to the batch.
        
        Args:
            batch: The event batch
            log_event: The log event to append
            event_size: Size of the event in bytes
        */
        batch["logEvents"].append(log_event)
        batch["byteTotal"] += event_size
        
        timestamp = log_event["timestamp"]
        if (batch["minTimestampMs"] == 0 or batch["minTimestampMs"] > timestamp) {
            batch["minTimestampMs"] = timestamp
        }
        
        if (batch["maxTimestampMs"] == 0 or batch["maxTimestampMs"] < timestamp) {
            batch["maxTimestampMs"] = timestamp
        }
    
    } 

    private sort_log_events(batch: Dict): None {
        /*
        Sort log events in the batch by timestamp.
        
        Args:
            batch: The event batch
        */
        batch["logEvents"] = sorted(batch["logEvents"], key=lambda x: x["timestamp"])
    
    } 

    private send_log_batch(batch: Dict): None {
        /*
        Send a batch of log events to CloudWatch Logs.
        
        Args:
            batch: The event batch
        */
        if (not batch["logEvents"]) {
            return
        }

        // Sort log events by timestamp
        this._sort_log_events(batch)
        
        // Prepare the PutLogEvents request
        put_log_events_input = {
            "logGroupName": this.log_group_name,
            "logStreamName": this.log_stream_name,
            "logEvents": batch["logEvents"]
        }
        
        start_time = time.time()
        
        try {
            // Create log group and stream if they don't exist
            try {
                this.logs_client.create_log_group(
                    logGroupName=this.log_group_name
                )
                diag.info(f"Created log group: {this.log_group_name}")
            } catch(e) { //[]except this.logs_client.exceptions.ResourceAlreadyExistsException:
                // Log group already exists, this is fine
                diag.debug(f"Log group {this.log_group_name} already exists")
            }
            
            // Create log stream if it doesn't exist
            try {
                this.logs_client.create_log_stream(
                    logGroupName=this.log_group_name,
                    logStreamName=this.log_stream_name
                )
                diag.info(f"Created log stream: {this.log_stream_name}")
            } catch(e) { //except this.logs_client.exceptions.ResourceAlreadyExistsException:
                // Log stream already exists, this is fine
                diag.debug(f"Log stream {this.log_stream_name} already exists")
            }
            
            // Make the PutLogEvents call
            response = this.logs_client.put_log_events(**put_log_events_input)
            
            elapsed_ms = int((time.time() - start_time) * 1000)
            diag.debug(
                f"Successfully sent {len(batch['logEvents'])} log events "
                f"({batch['byteTotal'] / 1024:.2f} KB) in {elapsed_ms} ms"
            )
            
            return response
            
        } catch(e) {
            diag.error(f"Failed to send log events: {e}")
            import traceback
            diag.error(traceback.format_exc())
            throw e
        }
    }
    
    // Event batch to store logs before sending to CloudWatch
    _event_batch = None
    
    private _send_log_event(log_event: Dict) {
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
            if (not this._validate_log_event(log_event)) {
                return
            }
            
            // Calculate event size
            event_size = len(log_event["message"]) + this.CW_PER_EVENT_HEADER_BYTES
            
            // Initialize event batch if needed
            if (this._event_batch is None) {
                this._event_batch = this._create_event_batch()
            }
            
            // Check if we need to send the current batch and create a new one
            current_batch = this._event_batch
            if ((this._event_batch_exceeds_limit(current_batch, event_size) or not this._is_batch_active(current_batch, log_event["timestamp"]))) {
                // Send the current batch
                this._send_log_batch(current_batch)
                // Create a new batch
                this._event_batch = this._create_event_batch()
                current_batch = this._event_batch
            }
            
            // Add the log event to the batch
            this._append_to_batch(current_batch, log_event, event_size)
            
        } catch(e) {
            diag.error(f"Failed to process log event: {e}")
            import traceback
            diag.error(traceback.format_exc())
            throw e
        }
    }
    
    public force_flush(timeout_millis: number = 10000): bool {
        /*
        Force flush any pending metrics.
        
        Args:
            timeout_millis: Timeout in milliseconds
            
        Returns:
            true if successful, false otherwise
        */
        if (this._event_batch is not None and len(this._event_batch["logEvents"]) > 0) {
            current_batch = this._event_batch
            this._send_log_batch(current_batch)
            this._event_batch = this._create_event_batch()
        }
        diag.debug(f"CloudWatchEMFExporter force flushes the bufferred metrics")
        return true
    }
    
    public shutdown(timeout_millis=None, **kwargs) {
        /*
        Shutdown the exporter.
        Override to handle timeout and other keyword arguments, but do nothing.
        
        Args:
            timeout_millis: Ignored timeout in milliseconds
            **kwargs: Ignored additional keyword arguments
        */
        // Intentionally do nothing
        this.force_flush(timeout_millis)
        diag.debug(`CloudWatchEMFExporter shutdown called with timeout_millis=${timeout_millis}`)
        return true
    }
}
