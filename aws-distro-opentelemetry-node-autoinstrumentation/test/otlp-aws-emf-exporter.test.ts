// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as api from '@opentelemetry/api-events';
import { Attributes, SpanContext, SpanKind } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import expect from 'expect';
import { LLOHandler } from '../src/llo-handler';
import { EventLogger, EventLoggerProvider } from '@opentelemetry/sdk-events';
import { Logger, LoggerOptions, LogRecord } from '@opentelemetry/api-logs';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import * as sinon from 'sinon';
import { Mutable } from '../src/utils';
import {
  CloudWatchLogsClient,
  CloudWatchLogsClientConfig,
  DescribeLogGroupsCommand,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  PutLogEventsCommandInput,
} from '@aws-sdk/client-cloudwatch-logs';
import * as nock from 'nock';
import { CloudWatchEMFExporter, createEmfExporter, CW_MAX_EVENT_PAYLOAD_BYTES, CW_MAX_REQUEST_EVENT_COUNT, CW_MAX_REQUEST_PAYLOAD_BYTES, CW_TRUNCATED_SUFFIX, Record, RECORD_DATA_TYPES, RecordValue } from '../src/otlp-aws-emf-exporter';
import { AggregationTemporality, DataPoint, ExponentialHistogram, Histogram } from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';


describe('TestBatchProcessing', () => {
  let mockClient;
  let region = 'us-east-1'
  let exporter: CloudWatchEMFExporter;

  before(() => {
      /* Set up test fixtures. */
      let mockClient = new CloudWatchLogsClient({
          region: region,
          credentials: {
            accessKeyId: 'abcde',
            secretAccessKey: 'abcde',
          },
      });
      //[]
      nock(`https://logs.${region}.amazonaws.com/`).post('/').reply(200, function (uri: any, requestBody: any) {
          // reqHeaders = this.req.headers;
          return [];
        });
        
        exporter = new CloudWatchEMFExporter('TestNamespace', 'test-log-group', undefined, undefined, undefined, true, AggregationTemporality.DELTA, {})

        // Mock the boto3 client to avoid AWS calls
        // mock_client = Mock()
        // mock_boto_client.return_value = mock_client
        // mock_client.describe_log_groups.return_value = {"logGroups": []}
        // mock_client.create_log_group.return_value = {}
        // self.exporter = CloudWatchEMFExporter(
        //     namespace="TestNamespace",
        //     log_group_name="test-log-group"
        // )
  });

  //[] afterEach(() => {
  //   sinon.restore();
  // });

    it('test_create_event_batch', () => {
        /* Test event batch creation. */
        let batch = exporter['createEventBatch']();
        
        expect(batch["logEvents"]).toEqual([]);
        expect(batch["byteTotal"]).toEqual(0);
        expect(batch["minTimestampMs"]).toEqual(0);
        expect(batch["maxTimestampMs"]).toEqual(0);
        expect(typeof batch["createdTimestampMs"]).toEqual('number');
    });
        
    it('test_validate_log_event_valid', () => {
        /* Test log event validation with valid event. */
        let log_event = {
            "message": "test message",
            "timestamp": Date.now()
        }
        
        let result = exporter['validateLogEvent'](log_event)
        expect(result).toBeTruthy();
    });
        
    it('test_validate_log_event_empty_message', () => {
        /* Test log event validation with empty message. */
        let log_event = {
            "message": "",
            "timestamp": Date.now()
        }
        
        let result = exporter['validateLogEvent'](log_event)
        expect(result).toBeFalsy();
    });
        
    it('test_validate_log_event_oversized_message', () => {
        /* Test log event validation with oversized message. */
        // Create a message larger than the maximum allowed size
        let large_message = "x".repeat(CW_MAX_EVENT_PAYLOAD_BYTES + 100)
        let log_event = {
            "message": large_message,
            "timestamp": Date.now()
        }
        
        let result = exporter['validateLogEvent'](log_event)
        expect(result).toBeTruthy();  // Should still be valid after truncation
        // Check that message was truncated
        expect(log_event["message"].length).toBeLessThan(large_message.length)
        expect(log_event["message"].endsWith(CW_TRUNCATED_SUFFIX)).toBeTruthy();
    });
        
    it('test_validate_log_event_old_timestamp', () => {
        /* Test log event validation with very old timestamp. */
        // Timestamp from 15 days ago
        let old_timestamp = Date.now() - (15 * 24 * 60 * 60 * 1000)
        let log_event = {
            "message": "test message",
            "timestamp": old_timestamp
        }
        
        let result = exporter['validateLogEvent'](log_event)
        expect(result).toBeFalsy();
    });
        
    it('test_validate_log_event_future_timestamp', () => {
        /* Test log event validation with future timestamp. */
        // Timestamp 3 hours in the future
        let future_timestamp = Date.now() + (3 * 60 * 60 * 1000)
        let log_event = {
            "message": "test message",
            "timestamp": future_timestamp
        }
        
        let result = exporter['validateLogEvent'](log_event)
        expect(result).toBeFalsy();
    });
        
    it('test_event_batch_exceeds_limit_by_count', () => {
        /* Test batch limit checking by event count. */
        let batch = exporter['createEventBatch']()
        // Simulate batch with maximum events
        batch["logEvents"] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({"message": "test"})
        
        let result = exporter['eventBatchExceedsLimit'](batch, 100)
        expect(result).toBeTruthy();
    });
        
    it('test_event_batch_exceeds_limit_by_size', () => {
        /* Test batch limit checking by byte size. */
        let batch = exporter['createEventBatch']()
        batch["byteTotal"] = CW_MAX_REQUEST_PAYLOAD_BYTES - 50
        
        let result = exporter['eventBatchExceedsLimit'](batch, 100)
        expect(result).toBeTruthy();
    });
        
    it('test_event_batch_within_limits', () => {
        /* Test batch limit checking within limits. */
        let batch = exporter['createEventBatch']()
        batch["logEvents"] = Array(10).fill({"message": "test"})
        batch["byteTotal"] = 1000
        
        let result = exporter['eventBatchExceedsLimit'](batch, 100)
        expect(result).toBeFalsy();
    });
        
    it('test_is_batch_active_new_batch', () => {
        /* Test batch activity check for new batch. */
        let batch = exporter['createEventBatch']()
        let current_time = Date.now()
        
        let result = exporter['isBatchActive'](batch, current_time)
        expect(result).toBeTruthy();
    });
        
    it('test_is_batch_active_24_hour_span', () => {
        /* Test batch activity check for 24+ hour span. */
        let batch = exporter['createEventBatch']()
        let current_time = Date.now()
        batch["minTimestampMs"] = current_time
        batch["maxTimestampMs"] = current_time
        
        // Test with timestamp 25 hours in the future
        let future_timestamp = current_time + (25 * 60 * 60 * 1000)
        
        let result = exporter['isBatchActive'](batch, future_timestamp)
        expect(result).toBeFalsy();
    });
        
    it('test_append_to_batch', () => {
        /* Test appending log event to batch. */
        let batch = exporter['createEventBatch']()
        let log_event = {
            "message": "test message",
            "timestamp": Date.now()
        }
        let event_size = 100
        
        exporter['appendToBatch'](batch, log_event, event_size)
        
        expect(batch["logEvents"].length).toEqual(1);
        expect(batch["byteTotal"]).toEqual(event_size);
        expect(batch["minTimestampMs"]).toEqual(log_event["timestamp"]);
        expect(batch["maxTimestampMs"]).toEqual(log_event["timestamp"]);
    });
        
    it('test_sort_log_events', () => {
        /* Test sorting log events by timestamp. */
        let batch = exporter['createEventBatch']()
        let current_time = Date.now()
        
        // Add events with timestamps in reverse order
        let events = [
            {"message": "third", "timestamp": current_time + 2000},
            {"message": "first", "timestamp": current_time},
            {"message": "second", "timestamp": current_time + 1000}
        ]
        
        batch["logEvents"] = {...events}
        exporter['sortLogEvents'](batch)
        
        // Check that events are now sorted by timestamp
        expect(batch["logEvents"][0]["message"]).toEqual("first");
        expect(batch["logEvents"][1]["message"]).toEqual("second");
        expect(batch["logEvents"][2]["message"]).toEqual("third");
    });
});

describe('TestCreateEMFExporter', () => {
    /* Test the create_emf_exporter function. */
    
    //[]@patch('boto3.client')
    it('test_create_emf_exporter_default_args', () => {
        /* Test creating exporter with default arguments. */
        // Mock the boto3 client to avoid AWS calls
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        let exporter = createEmfExporter()
        
        expect(exporter).toBeInstanceOf(CloudWatchEMFExporter);
        expect(exporter['namespace']).toEqual("OTelPython");
    });
    
    //[] //[]@patch('boto3.client')
    it('test_create_emf_exporter_custom_args', () => {
        /* Test creating exporter with custom arguments. */
        // Mock the boto3 client to avoid AWS calls
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        let exporter = createEmfExporter(
            "CustomNamespace",
            "/custom/log/group",
            undefined,
            "us-west-2"
        )
        
        expect(exporter).toBeInstanceOf(CloudWatchEMFExporter);
        expect(exporter['namespace']).toEqual("CustomNamespace");
        expect(exporter['logGroupName']).toEqual("/custom/log/group");
    });
    
    //[]@patch('boto3.client')
    //[]@patch('logging.basicConfig')
    //[] def test_create_emf_exporter_debug_mode(self, mock_logging_config, mock_boto_client):
    it('test_create_emf_exporter_debug_mode', () => {
        /* Test creating exporter with debug mode enabled. */
        // Mock the boto3 client to avoid AWS calls
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        let exporter = createEmfExporter('OTelJavaScript', '/aws/otel/javascript', undefined, undefined, true);

        expect(exporter).toBeInstanceOf(CloudWatchEMFExporter);
        mock_logging_config.assert_called_once()
    });
  });

describe('TestSendLogBatch', () => {
  let exporter: CloudWatchEMFExporter;

    //[]@patch('boto3.Session')
    before(() => {
    //[] def setUp(self, mock_session):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        //[] self.mock_client = Mock()
        // self.mock_client.describe_log_groups.return_value = {"logGroups": []}
        // self.mock_client.create_log_group.return_value = {}
        // self.mock_client.create_log_stream.return_value = {}
        // self.mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // // Create a proper exception class for ResourceAlreadyExistsException
        // class ResourceAlreadyExistsException(Exception):
        //     pass
        
        // self.mock_client.exceptions.ResourceAlreadyExistsException = ResourceAlreadyExistsException
        
        // // Mock session to return our mock client
        // let mock_session_instance = Mock()
        // mock_session.return_value = mock_session_instance
        // mock_session_instance.client.return_value = self.mock_client
        

        exporter = new CloudWatchEMFExporter('TestNamespace', 'test-log-group', undefined, undefined, undefined, true, AggregationTemporality.DELTA, {})
    });
        
    it('test_send_log_batch_empty', () => {
        /* Test sending empty log batch. */
        let batch = exporter['createEventBatch']()
        
        // Should not make any AWS calls for empty batch
        exporter['sendLogBatch'](batch)
        self.mock_client.put_log_events.assert_not_called()
    });
        
    it('test_send_log_batch_with_events', () => {
        /* Test sending log batch with events. */
        let batch = exporter['createEventBatch']()
        let current_time = Date.now()
        
        // Add some log events
        let events = [
            {"message": "first message", "timestamp": current_time},
            {"message": "second message", "timestamp": current_time + 1000}
        ]
        
        for (const event of events) {
            batch["logEvents"].push(event)
        }
        
        exporter['sendLogBatch'](batch)
        
        // Verify put_log_events was called
        self.mock_client.put_log_events.assert_called_once()
        let call_args = self.mock_client.put_log_events.call_args[1]
        
        expect(call_args["logGroupName"]).toEqual("test-log-group");
        expect(call_args["logEvents"].length).toEqual(2);
    });
        
    it('test_send_log_batch_sorts_events', () => {
        /* Test that log batch sorting works correctly. */
        let batch = exporter['createEventBatch']()
        let current_time = Date.now()
        
        // Add events in reverse timestamp order
        let events = [
            {"message": "second", "timestamp": current_time + 1000},
            {"message": "first", "timestamp": current_time}
        ]
        
        for (const event of events) {
            batch["logEvents"].push(event)
        }
        
        exporter['sendLogBatch'](batch)
        
        // Verify events were sorted by timestamp
        let call_args = self.mock_client.put_log_events.call_args[1]
        let sorted_events = call_args["logEvents"]
        
        expect(sorted_events[0]["message"]).toEqual("first");
        expect(sorted_events[1]["message"]).toEqual("second");
    });
        
    it('test_send_log_batch_handles_exceptions', () => {
        /* Test that send_log_batch handles exceptions properly. */
        let batch = exporter['createEventBatch']()
        batch["logEvents"].append({"message": "test", "timestamp": Date.now()})
        
        // Make create_log_group raise an exception (this happens first)
        self.mock_client.create_log_group.side_effect = Exception("AWS error")
        
        with self.assertRaises(Exception):
            exporter['sendLogBatch'](batch)
    });
});

describe('TestSendLogEvent', () => {
//[] class TestSendLogEvent(unittest.TestCase):
    /* Test individual log event sending functionality. */
    let exporter: CloudWatchEMFExporter;
    
    //[]@patch('boto3.Session')
    before(() => {
    //[] def setUp(self, mock_session):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        //[] self.mock_client = Mock()
        // self.mock_client.describe_log_groups.return_value = {"logGroups": []}
        // self.mock_client.create_log_group.return_value = {}
        // self.mock_client.create_log_stream.return_value = {}
        // self.mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // // Create a proper exception class for ResourceAlreadyExistsException
        // class ResourceAlreadyExistsException(Exception):
        //     pass
        
        // self.mock_client.exceptions.ResourceAlreadyExistsException = ResourceAlreadyExistsException
        
        // // Mock session to return our mock client
        // let mock_session_instance = Mock()
        // mock_session.return_value = mock_session_instance
        // mock_session_instance.client.return_value = self.mock_client
        
        exporter = new CloudWatchEMFExporter('TestNamespace', 'test-log-group', undefined, undefined, undefined, true, AggregationTemporality.DELTA, {})
    });
        
    it('test_send_log_event_creates_batch', () => {
        /* Test that sending first log event creates a batch. */
        let log_event = {
            "message": "test message",
            "timestamp": Date.now()
        }
        
        // Initially no batch should exist
        expect(exporter['eventBatch']).toBeUndefined()
        
        exporter['sendLogEvent'](log_event)
        
        // Batch should now be created
        expect(exporter['eventBatch']).not.toBeUndefined();
        expect(exporter['eventBatch'] ? exporter['eventBatch']["logEvents"].length : -1).toEqual(1);
    });
        
    it('test_send_log_event_invalid_event', () => {
        /* Test sending invalid log event. */
        let log_event = {
            "message": "",  // Empty message should be invalid
            "timestamp": Date.now()
        }
        
        exporter['sendLogEvent'](log_event)
        
        // Batch should not be created for invalid event
        expect(exporter['eventBatch']).toBeUndefined()
      })
    
    //[]@patch.object(CloudWatchEMFExporter, '_send_log_batch')
    //[] def test_send_log_event_triggers_batch_send(self, mock_send_batch):
    it('test_send_log_event_triggers_batch_send', () => {
        /* Test that exceeding batch limits triggers batch send. */
        // First, add an event to create a batch
        let log_event = {
            "message": "test message",
            "timestamp": Date.now()
        }
        exporter['sendLogEvent'](log_event)
        
        // Now simulate batch being at limit        
        exporter['eventBatch']!["logEvents"] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({"message": "test"})
        
        // Send another event that should trigger batch send
        exporter['sendLogEvent'](log_event)
        
        // Verify batch was sent
        mock_send_batch.assert_called()
      })
});

describe('TestCloudWatchEMFExporter', () => {
//[] class TestCloudWatchEMFExporter(unittest.TestCase):
    /* Test CloudWatchEMFExporter class. */
    let exporter: CloudWatchEMFExporter;
    
    //[]@patch('boto3.client')
    before(() => {
    //[] def setUp(self, mock_boto_client):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}

        exporter = new CloudWatchEMFExporter('TestNamespace', 'test-log-group', undefined, undefined, undefined, true, AggregationTemporality.DELTA, {})
    });
        
    it('test_initialization', () => {
        /* Test exporter initialization. */
        expect(exporter['namespace']).toEqual("TestNamespace");
        expect(exporter['logStreamName']).not.toBeUndefined();
        expect(exporter['metricDeclarations']).toEqual([]);
    });
    
    //[]@patch('boto3.client')
    //[] def test_initialization_with_custom_params(self, mock_boto_client):
    it('test_initialization_with_custom_params', () => {
        /* Test exporter initialization with custom parameters. */
        // Mock the boto3 client to avoid AWS calls
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        //[]
        let newExporter = new CloudWatchEMFExporter(
            "CustomNamespace",
            "custom-log-group",
            "custom-stream",
            "us-west-2",
            undefined, true, AggregationTemporality.DELTA, {})

        expect(newExporter['namespace']).toEqual("CustomNamespace");
        expect(newExporter['logGroupName']).toEqual("custom-log-group");
        expect(newExporter['logStreamName']).toEqual("custom-stream");
    });

    it('test_get_unit_mapping', () => {
        /* Test unit mapping functionality. */
        // Test known units
        expect(exporter['getUnit']({ name: 'testName', unit: 'ms', description: 'testDescription'})).toEqual("Milliseconds");
        expect(exporter['getUnit']({ name: 'testName', unit: 's', description: 'testDescription'})).toEqual("Seconds");
        expect(exporter['getUnit']({ name: 'testName', unit: 'By', description: 'testDescription'})).toEqual("Bytes");
        expect(exporter['getUnit']({ name: 'testName', unit: '%', description: 'testDescription'})).toEqual("Percent");
        
        // Test unknown unit
        expect(exporter['getUnit']({ name: 'testName', unit: 'unknown', description: 'testDescription'})).toEqual("unknown");
        
        // Test empty unit (should return None due to falsy check)
        expect(exporter['getUnit']({ name: 'testName', unit: '', description: 'testDescription'})).toBeUndefined()
        
        //[][not needed...] Test undefined unit
        expect(exporter['getUnit']({ name: 'testName', unit: undefined, description: 'testDescription'} as any)).toBeUndefined();
    });
        
    it('test_get_metric_name', () => {
        /* Test metric name extraction. */
        // Test with record that has instrument.name
        let record = Mock()
        record.instrument = Mock()
        record.instrument.name = "test_metric"
        delete record.name  // Ensure record.name doesn't exist
        
        let result = exporter['getMetricName'](record)
        expect(result).toEqual("test_metric");
        
        // Test with record that has direct name attribute
        let record_with_name = Mock()
        record_with_name.name = "direct_metric"
        
        let result2 = exporter['getMetricName'](record_with_name)
        expect(result2).toEqual("direct_metric");
    });
        
    it('test_get_dimension_names', () => {
        /* Test dimension names extraction. */
        let attributes = {"service.name": "test-service", "env": "prod", "region": "us-east-1"}
        
        let result = exporter['getDimensionNames'](attributes)
        
        // Should return all attribute keys
        expect(result).toContain('service.name')
        expect(result).toContain('env')
        expect(result).toContain('region')
    });
        
    it('test_get_attributes_key', () => {
        /* Test attributes key generation. */
        let attributes = {"service": "test", "env": "prod"}
        
        let result = exporter['getAttributesKey'](attributes)
        
        // Should be a string representation of sorted attributes
        expect(typeof result).toEqual('string');
        expect(result).toHaveProperty('service')
        expect(result).toHaveProperty("test")
        expect(result).toHaveProperty("env")
        expect(result).toHaveProperty("prod")
    });
        
    it('test_get_attributes_key_consistent', () => {
        /* Test that attributes key generation is consistent. */
        // Same attributes in different order should produce same key
        const attrs1 = {"b": "2", "a": "1"}
        const attrs2 = {"a": "1", "b": "2"}
        
        const key1 = exporter['getAttributesKey'](attrs1)
        const key2 = exporter['getAttributesKey'](attrs2)
        
        expect(key1).toEqual(key2);
    });
        
    it('test_group_by_attributes_and_timestamp', () => {
        /* Test grouping by attributes and timestamp. */
        let record = Mock()
        record.attributes = {"env": "test"}
        let timestamp_ms = 1234567890
        
        let result = exporter['groupByAttributesAndTimestamp'](record, timestamp_ms)
        
        // Should return a tuple with attributes key and timestamp
        self.assertIsInstance(result, tuple)
        expect(result.length).toEqual(2);
        expect(result[1]).toEqual(timestamp_ms);
    });
        
    it('test_generate_log_stream_name', () => {
        /* Test log stream name generation. */
        let name1 = exporter['generateLogStreamName']()
        let name2 = exporter['generateLogStreamName']()
        
        // Should generate unique names
        expect(name1).not.toEqual(name2)
        expect(name1.startsWith("otel-python-")).toBeTruthy();
        expect(name2.startsWith("otel-python-")).toBeTruthy();
    });
        
    it('test_normalize_timestamp', () => {
        /* Test timestamp normalization. */
        let timestamp_ns = 1609459200000000000  // 2021-01-01 00:00:00 in nanoseconds
        let expected_ms = 1609459200000  // Same time in milliseconds
        
        let result = exporter['normalizeTimestamp']([0, timestamp_ns])
        expect(result).toEqual(expected_ms);
    });
        
    it('test_create_metric_record', () => {
        /* Test metric record creation. */
        let record = exporter['createMetricRecord']("test_metric", "Count", "Test description")
        
        expect(record).not.toBeUndefined();
        expect(record.instrument).not.toBeUndefined();
        expect(record.instrument.name).toEqual("test_metric");
        expect(record.instrument.unit).toEqual("Count");
        expect(record.instrument.description).toEqual("Test description");
    });
        
    it('test_convert_gauge', () => {
        /* Test gauge conversion. */
        let metric = MockMetric("gauge_metric", "Count", "Gauge description")
        let dp:DataPoint<number> = MockDataPoint(value=42.5, attributes={"key": "value"})
        
        const [record, timestamp] = exporter['convertGauge'](metric, dp);
        
        expect(record).not.toBeUndefined();
        expect(record.instrument.name).toEqual("gauge_metric");
        expect(record.value).toEqual(42.5);
        expect(record.attributes).toEqual({"key": "value"});
        expect(typeof timestamp).toEqual('number');
    });
        
    it('test_convert_sum', () => {
        /* Test sum conversion with the bug fix. */
        let metric = MockMetric("sum_metric", "Count", "Sum description")
        let dp:DataPoint<number> = MockDataPoint(value=100.0, attributes={"env": "test"})
        
        const [record, timestamp] = exporter['convertSum'](metric, dp);
        
        expect(record).not.toBeUndefined();
        expect(record.instrument.name).toEqual("sum_metric");
        expect(record).toHaveProperty('sumData');
        expect(record.sumData?.value).toEqual(100.0);
        expect(record.attributes).toEqual({"env": "test"});
        expect(typeof timestamp).toEqual('number');
    });
        
    it('test_convert_histogram', () => {
        /* Test histogram conversion. */
        let metric = MockMetric("histogram_metric", "ms", "Histogram description")
        let dp: DataPoint<Histogram> = MockHistogramDataPoint(
            count=10,
            sum_val=150.0,
            min_val=5.0,
            max_val=25.0,
            attributes={"region": "us-east-1"}
        )
        
        const [record, timestamp] = exporter['convertHistogram'](metric, dp);
        
        expect(record).not.toBeUndefined();
        expect(record.instrument.name).toEqual("histogram_metric");
        expect(record).toHaveProperty('histogramData');
        
        let expected_value = {
            "Count": 10,
            "Sum": 150.0,
            "Min": 5.0,
            "Max": 25.0
        }
        expect(record.histogramData?.value).toEqual(expected_value);
        expect(record.attributes).toEqual({"region": "us-east-1"});
        expect(typeof timestamp).toEqual('number');
    });
        
    it('test_convert_exp_histogram', () => {
        /* Test exponential histogram conversion. */
        let metric = MockMetric("exp_histogram_metric", "s", "Exponential histogram description")
        let dp: DataPoint<ExponentialHistogram> = MockExpHistogramDataPoint(
            count=8,
            sum_val=64.0,
            min_val=2.0,
            max_val=32.0,
            attributes={"service": "api"}
        )
        
        const [record, timestamp] = exporter['convertExpHistogram'](metric, dp);
        
        expect(record).not.toBeUndefined();
        expect(record.instrument.name).toEqual("exp_histogram_metric");
        expect(record).toHaveProperty('expHistogramData');
        
        const exp_data = record.expHistogramData?.value
        expect(exp_data).toHaveProperty("Values")
        expect(exp_data).toHaveProperty("Counts")
        expect((exp_data as RecordValue)["Count"]).toEqual(8);
        expect((exp_data as RecordValue)["Sum"]).toEqual(64.0);
        expect((exp_data as RecordValue)["Min"]).toEqual(2.0);
        expect((exp_data as RecordValue)["Max"]).toEqual(32.0);
        expect(record.attributes).toEqual({"service": "api"});
        expect(typeof timestamp).toEqual('number');
    });
        
    it('test_create_emf_log', () => {
        /* Test EMF log creation. */
        // Create test records
        let gauge_record: Record = {
          ...exporter['createMetricRecord']("gauge_metric", "Count", "Gauge"),
          value: 50.0,
          timestamp: Date.now(),
          attributes: {"env": "test"}
        }
        
        let sum_record: Record = {
          ...exporter['createMetricRecord']("sum_metric", "Count", "Sum"),
          sumData: {
            value: 100.0,
            type: RECORD_DATA_TYPES.SUM_DATA
          },
          timestamp: Date.now(),
          attributes: {"env": "test"}
        }
        
        let records = [gauge_record, sum_record]
        let resource = new Resource({"service.name": "test-service"})
        
        
        let result = exporter['createEmfLog'](records, resource)
        
        self.assertIsInstance(result, dict)
        
        // Check that the result is JSON serializable
        json.dumps(result)  // Should not raise exception
    });
    
    //[]@patch('boto3.client')
    //[] def test_export_success(self, mock_boto_client):
    it('test_export_success', () => {
        /* Test successful export. */
        // Mock CloudWatch Logs client
        let mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // Create empty metrics data to test basic export flow
        let metrics_data = Mock()
        metrics_data.resource_metrics = []
        
        let result = exporter.export(metrics_data, () => {})
        
        expect(result).toEqual(ExportResultCode.SUCCESS);
    });
        
    it('test_export_failure', () => {
        /* Test export failure handling. */
        // Create metrics data that will cause an exception during iteration
        let metrics_data = Mock()
        // Make resource_metrics raise an exception when iterated over
        metrics_data.resource_metrics = Mock()
        metrics_data.resource_metrics.__iter__ = Mock(side_effect=Exception("Test exception"))
        
        let result = exporter.export(metrics_data, () => {})
        
        expect(result).toEqual(ExportResultCode.FAILED);
    });
    
    //[]@patch.object(CloudWatchEMFExporter, '_send_log_batch')
    //[] def test_force_flush_with_pending_events(self, mock_send_batch):
    it('test_force_flush_with_pending_events', () => {
        /* Test force flush functionality with pending events. */
        // Create a batch with events
        exporter['eventBatch'] = exporter['createEventBatch']()
        exporter['eventBatch']["logEvents"] = [{"message": "test", "timestamp": Date.now()}]
        
        let result = exporter.forceFlush()
        
        expect(result).toBeTruthy();
        mock_send_batch.assert_called_once()
    });
        
    it('test_force_flush_no_pending_events', () => {
        /* Test force flush functionality with no pending events. */
        // No batch exists
        expect(exporter['eventBatch']).toBeUndefined()
        
        let result = exporter.forceFlush()
        
        expect(result).toBeTruthy();
    });
    
    //[]@patch.object(CloudWatchEMFExporter, 'force_flush')
    //[] def test_shutdown(self, mock_force_flush):
    it('test_shutdown', () => {
        /* Test shutdown functionality. */
        
        // Ensure this call doesn't reject
        let result = await exporter.shutdown()

        mock_force_flush.assert_called_once_with(5000)
    });
    

    
    function _create_test_metrics_data(self) {
        /* Helper method to create test metrics data. */
        // Create a gauge metric data point
        let gauge_dp = MockDataPoint(value=25.0, attributes={"env": "test"})
        
        // Create gauge metric data using MockGaugeData
        let gauge_data = MockGaugeData([gauge_dp])
        
        // Create gauge metric
        let gauge_metric = Mock()
        gauge_metric.name = "test_gauge"
        gauge_metric.unit = "Count"
        gauge_metric.description = "Test gauge"
        gauge_metric.data = gauge_data
        
        // Create scope metrics
        let scope_metrics = MockScopeMetrics(metrics=[gauge_metric])
        
        // Create resource metrics
        let resource_metrics = MockResourceMetrics(scope_metrics=[scope_metrics])
        
        // Create metrics data
        let metrics_data = Mock()
        metrics_data.resource_metrics = [resource_metrics]
        
        return metrics_data
  }
});
