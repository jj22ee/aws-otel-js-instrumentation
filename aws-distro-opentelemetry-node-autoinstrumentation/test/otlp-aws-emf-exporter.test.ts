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
import { CloudWatchEMFExporter } from '../src/otlp-aws-emf-exporter';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';


describe('TestBatchProcessing', () => {
  let mockClient;
  let region = 'us-east-1'
  let exporter;

  before(() => {
      /* Set up test fixtures. */
      mockClient = new CloudWatchLogsClient({
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
        batch = self.exporter._create_event_batch()
        
        self.assertEqual(batch["logEvents"], [])
        self.assertEqual(batch["byteTotal"], 0)
        self.assertEqual(batch["minTimestampMs"], 0)
        self.assertEqual(batch["maxTimestampMs"], 0)
        self.assertIsInstance(batch["createdTimestampMs"], int)
    });
        
    it('test_validate_log_event_valid', () => {
        /* Test log event validation with valid event. */
        log_event = {
            "message": "test message",
            "timestamp": int(time.time() * 1000)
        }
        
        result = self.exporter._validate_log_event(log_event)
        self.assertTrue(result)
    });
        
    it('test_validate_log_event_empty_message', () => {
        /* Test log event validation with empty message. */
        log_event = {
            "message": "",
            "timestamp": int(time.time() * 1000)
        }
        
        result = self.exporter._validate_log_event(log_event)
        self.assertFalse(result)
    });
        
    it('test_validate_log_event_oversized_message', () => {
        /* Test log event validation with oversized message. */
        // Create a message larger than the maximum allowed size
        large_message = "x" * (self.exporter.CW_MAX_EVENT_PAYLOAD_BYTES + 100)
        log_event = {
            "message": large_message,
            "timestamp": int(time.time() * 1000)
        }
        
        result = self.exporter._validate_log_event(log_event)
        self.assertTrue(result)  // Should still be valid after truncation
        // Check that message was truncated
        self.assertLess(len(log_event["message"]), len(large_message))
        self.assertTrue(log_event["message"].endswith(self.exporter.CW_TRUNCATED_SUFFIX))
    });
        
    it('test_validate_log_event_old_timestamp', () => {
        /* Test log event validation with very old timestamp. */
        // Timestamp from 15 days ago
        old_timestamp = int(time.time() * 1000) - (15 * 24 * 60 * 60 * 1000)
        log_event = {
            "message": "test message",
            "timestamp": old_timestamp
        }
        
        result = self.exporter._validate_log_event(log_event)
        self.assertFalse(result)
    });
        
    it('test_validate_log_event_future_timestamp', () => {
        /* Test log event validation with future timestamp. */
        // Timestamp 3 hours in the future
        future_timestamp = int(time.time() * 1000) + (3 * 60 * 60 * 1000)
        log_event = {
            "message": "test message",
            "timestamp": future_timestamp
        }
        
        result = self.exporter._validate_log_event(log_event)
        self.assertFalse(result)
    });
        
    it('test_event_batch_exceeds_limit_by_count', () => {
        /* Test batch limit checking by event count. */
        batch = self.exporter._create_event_batch()
        // Simulate batch with maximum events
        batch["logEvents"] = [{"message": "test"}] * self.exporter.CW_MAX_REQUEST_EVENT_COUNT
        
        result = self.exporter._event_batch_exceeds_limit(batch, 100)
        self.assertTrue(result)
    });
        
    it('test_event_batch_exceeds_limit_by_size', () => {
        /* Test batch limit checking by byte size. */
        batch = self.exporter._create_event_batch()
        batch["byteTotal"] = self.exporter.CW_MAX_REQUEST_PAYLOAD_BYTES - 50
        
        result = self.exporter._event_batch_exceeds_limit(batch, 100)
        self.assertTrue(result)
    });
        
    it('test_event_batch_within_limits', () => {
        /* Test batch limit checking within limits. */
        batch = self.exporter._create_event_batch()
        batch["logEvents"] = [{"message": "test"}] * 10
        batch["byteTotal"] = 1000
        
        result = self.exporter._event_batch_exceeds_limit(batch, 100)
        self.assertFalse(result)
    });
        
    it('test_is_batch_active_new_batch', () => {
        /* Test batch activity check for new batch. */
        batch = self.exporter._create_event_batch()
        current_time = int(time.time() * 1000)
        
        result = self.exporter._is_batch_active(batch, current_time)
        self.assertTrue(result)
    });
        
    it('test_is_batch_active_24_hour_span', () => {
        /* Test batch activity check for 24+ hour span. */
        batch = self.exporter._create_event_batch()
        current_time = int(time.time() * 1000)
        batch["minTimestampMs"] = current_time
        batch["maxTimestampMs"] = current_time
        
        // Test with timestamp 25 hours in the future
        future_timestamp = current_time + (25 * 60 * 60 * 1000)
        
        result = self.exporter._is_batch_active(batch, future_timestamp)
        self.assertFalse(result)
    });
        
    it('test_append_to_batch', () => {
        /* Test appending log event to batch. */
        batch = self.exporter._create_event_batch()
        log_event = {
            "message": "test message",
            "timestamp": int(time.time() * 1000)
        }
        event_size = 100
        
        self.exporter._append_to_batch(batch, log_event, event_size)
        
        self.assertEqual(len(batch["logEvents"]), 1)
        self.assertEqual(batch["byteTotal"], event_size)
        self.assertEqual(batch["minTimestampMs"], log_event["timestamp"])
        self.assertEqual(batch["maxTimestampMs"], log_event["timestamp"])
    });
        
    it('test_sort_log_events', () => {
        /* Test sorting log events by timestamp. */
        batch = self.exporter._create_event_batch()
        current_time = int(time.time() * 1000)
        
        // Add events with timestamps in reverse order
        events = [
            {"message": "third", "timestamp": current_time + 2000},
            {"message": "first", "timestamp": current_time},
            {"message": "second", "timestamp": current_time + 1000}
        ]
        
        batch["logEvents"] = events.copy()
        self.exporter._sort_log_events(batch)
        
        // Check that events are now sorted by timestamp
        self.assertEqual(batch["logEvents"][0]["message"], "first")
        self.assertEqual(batch["logEvents"][1]["message"], "second")
        self.assertEqual(batch["logEvents"][2]["message"], "third")
    });
});

describe('TestCreateEMFExporter', () => {
    /* Test the create_emf_exporter function. */
    
    //[]@patch('boto3.client')
    it('test_create_emf_exporter_default_args', () => {
        /* Test creating exporter with default arguments. */
        // Mock the boto3 client to avoid AWS calls
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        exporter = create_emf_exporter()
        
        self.assertIsInstance(exporter, CloudWatchEMFExporter)
        self.assertEqual(exporter.namespace, "OTelPython")
    });
    
    //[] //[]@patch('boto3.client')
    it('test_create_emf_exporter_custom_args', () => {
        /* Test creating exporter with custom arguments. */
        // Mock the boto3 client to avoid AWS calls
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        exporter = create_emf_exporter(
            namespace="CustomNamespace",
            log_group_name="/custom/log/group",
            aws_region="us-west-2"
        )
        
        self.assertIsInstance(exporter, CloudWatchEMFExporter)
        self.assertEqual(exporter.namespace, "CustomNamespace")
        self.assertEqual(exporter.log_group_name, "/custom/log/group")
    });
    
    //[]@patch('boto3.client')
    //[]@patch('logging.basicConfig')
    //[] def test_create_emf_exporter_debug_mode(self, mock_logging_config, mock_boto_client):
    it('test_create_emf_exporter_debug_mode', () => {
        /* Test creating exporter with debug mode enabled. */
        // Mock the boto3 client to avoid AWS calls
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        exporter = create_emf_exporter(debug=True)
        
        self.assertIsInstance(exporter, CloudWatchEMFExporter)
        mock_logging_config.assert_called_once()
    });
  });

describe('TestSendLogBatch', () => {

    //[]@patch('boto3.Session')
    before(() => {
    //[] def setUp(self, mock_session):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        self.mock_client = Mock()
        self.mock_client.describe_log_groups.return_value = {"logGroups": []}
        self.mock_client.create_log_group.return_value = {}
        self.mock_client.create_log_stream.return_value = {}
        self.mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // Create a proper exception class for ResourceAlreadyExistsException
        class ResourceAlreadyExistsException(Exception):
            pass
        
        self.mock_client.exceptions.ResourceAlreadyExistsException = ResourceAlreadyExistsException
        
        // Mock session to return our mock client
        mock_session_instance = Mock()
        mock_session.return_value = mock_session_instance
        mock_session_instance.client.return_value = self.mock_client
        
        self.exporter = CloudWatchEMFExporter(
            namespace="TestNamespace",
            log_group_name="test-log-group"
        )
    });
        
    it('test_send_log_batch_empty', () => {
        /* Test sending empty log batch. */
        batch = self.exporter._create_event_batch()
        
        // Should not make any AWS calls for empty batch
        self.exporter._send_log_batch(batch)
        self.mock_client.put_log_events.assert_not_called()
    });
        
    it('test_send_log_batch_with_events', () => {
        /* Test sending log batch with events. */
        batch = self.exporter._create_event_batch()
        current_time = int(time.time() * 1000)
        
        // Add some log events
        events = [
            {"message": "first message", "timestamp": current_time},
            {"message": "second message", "timestamp": current_time + 1000}
        ]
        
        for event in events:
            batch["logEvents"].append(event)
        
        self.exporter._send_log_batch(batch)
        
        // Verify put_log_events was called
        self.mock_client.put_log_events.assert_called_once()
        call_args = self.mock_client.put_log_events.call_args[1]
        
        self.assertEqual(call_args["logGroupName"], "test-log-group")
        self.assertEqual(len(call_args["logEvents"]), 2)
    });
        
    it('test_send_log_batch_sorts_events', () => {
        /* Test that log batch sorting works correctly. */
        batch = self.exporter._create_event_batch()
        current_time = int(time.time() * 1000)
        
        // Add events in reverse timestamp order
        events = [
            {"message": "second", "timestamp": current_time + 1000},
            {"message": "first", "timestamp": current_time}
        ]
        
        for event in events:
            batch["logEvents"].append(event)
        
        self.exporter._send_log_batch(batch)
        
        // Verify events were sorted by timestamp
        call_args = self.mock_client.put_log_events.call_args[1]
        sorted_events = call_args["logEvents"]
        
        self.assertEqual(sorted_events[0]["message"], "first")
        self.assertEqual(sorted_events[1]["message"], "second")
    });
        
    it('test_send_log_batch_handles_exceptions', () => {
        /* Test that send_log_batch handles exceptions properly. */
        batch = self.exporter._create_event_batch()
        batch["logEvents"].append({"message": "test", "timestamp": int(time.time() * 1000)})
        
        // Make create_log_group raise an exception (this happens first)
        self.mock_client.create_log_group.side_effect = Exception("AWS error")
        
        with self.assertRaises(Exception):
            self.exporter._send_log_batch(batch)
    });
});

describe('TestSendLogEvent', () => {
//[] class TestSendLogEvent(unittest.TestCase):
    /* Test individual log event sending functionality. */
    
    //[]@patch('boto3.Session')
    before(() => {
    //[] def setUp(self, mock_session):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        self.mock_client = Mock()
        self.mock_client.describe_log_groups.return_value = {"logGroups": []}
        self.mock_client.create_log_group.return_value = {}
        self.mock_client.create_log_stream.return_value = {}
        self.mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // Create a proper exception class for ResourceAlreadyExistsException
        class ResourceAlreadyExistsException(Exception):
            pass
        
        self.mock_client.exceptions.ResourceAlreadyExistsException = ResourceAlreadyExistsException
        
        // Mock session to return our mock client
        mock_session_instance = Mock()
        mock_session.return_value = mock_session_instance
        mock_session_instance.client.return_value = self.mock_client
        
        self.exporter = CloudWatchEMFExporter(
            namespace="TestNamespace",
            log_group_name="test-log-group"
        )
    });
        
    it('test_send_log_event_creates_batch', () => {
        /* Test that sending first log event creates a batch. */
        log_event = {
            "message": "test message",
            "timestamp": int(time.time() * 1000)
        }
        
        // Initially no batch should exist
        self.assertIsNone(self.exporter._event_batch)
        
        self.exporter._send_log_event(log_event)
        
        // Batch should now be created
        self.assertIsNotNone(self.exporter._event_batch)
        self.assertEqual(len(self.exporter._event_batch["logEvents"]), 1)
    });
        
    it('test_send_log_event_invalid_event', () => {
        /* Test sending invalid log event. */
        log_event = {
            "message": "",  // Empty message should be invalid
            "timestamp": int(time.time() * 1000)
        }
        
        self.exporter._send_log_event(log_event)
        
        // Batch should not be created for invalid event
        self.assertIsNone(self.exporter._event_batch)
      })
    
    //[]@patch.object(CloudWatchEMFExporter, '_send_log_batch')
    //[] def test_send_log_event_triggers_batch_send(self, mock_send_batch):
    it('test_send_log_event_triggers_batch_send', () => {
        /* Test that exceeding batch limits triggers batch send. */
        // First, add an event to create a batch
        log_event = {
            "message": "test message",
            "timestamp": int(time.time() * 1000)
        }
        self.exporter._send_log_event(log_event)
        
        // Now simulate batch being at limit
        self.exporter._event_batch["logEvents"] = [{"message": "test"}] * self.exporter.CW_MAX_REQUEST_EVENT_COUNT
        
        // Send another event that should trigger batch send
        self.exporter._send_log_event(log_event)
        
        // Verify batch was sent
        mock_send_batch.assert_called()
      })
});

describe('TestCloudWatchEMFExporter', () => {
//[] class TestCloudWatchEMFExporter(unittest.TestCase):
    /* Test CloudWatchEMFExporter class. */
    
    //[]@patch('boto3.client')
    before(() => {
    //[] def setUp(self, mock_boto_client):
        /* Set up test fixtures. */
        // Mock the boto3 client to avoid AWS calls
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        self.exporter = CloudWatchEMFExporter(
            namespace="TestNamespace",
            log_group_name="test-log-group"
        )
    });
        
    it('test_initialization', () => {
        /* Test exporter initialization. */
        self.assertEqual(self.exporter.namespace, "TestNamespace")
        self.assertIsNotNone(self.exporter.log_stream_name)
        self.assertEqual(self.exporter.metric_declarations, [])
    });
    
    //[]@patch('boto3.client')
    //[] def test_initialization_with_custom_params(self, mock_boto_client):
    it('test_initialization_with_custom_params', () => {
        /* Test exporter initialization with custom parameters. */
        // Mock the boto3 client to avoid AWS calls
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.describe_log_groups.return_value = {"logGroups": []}
        mock_client.create_log_group.return_value = {}
        
        exporter = CloudWatchEMFExporter(
            namespace="CustomNamespace",
            log_group_name="custom-log-group",
            log_stream_name="custom-stream",
            aws_region="us-west-2"
        )
        self.assertEqual(exporter.namespace, "CustomNamespace")
        self.assertEqual(exporter.log_group_name, "custom-log-group")
        self.assertEqual(exporter.log_stream_name, "custom-stream")
    });
        
    it('test_get_unit_mapping', () => {
        /* Test unit mapping functionality. */
        // Test known units
        self.assertEqual(self.exporter._get_unit(Mock(unit="ms")), "Milliseconds")
        self.assertEqual(self.exporter._get_unit(Mock(unit="s")), "Seconds")
        self.assertEqual(self.exporter._get_unit(Mock(unit="By")), "Bytes")
        self.assertEqual(self.exporter._get_unit(Mock(unit="%")), "Percent")
        
        // Test unknown unit
        self.assertEqual(self.exporter._get_unit(Mock(unit="unknown")), "unknown")
        
        // Test empty unit (should return None due to falsy check)
        self.assertIsNone(self.exporter._get_unit(Mock(unit="")))
        
        // Test None unit
        self.assertIsNone(self.exporter._get_unit(Mock(unit=None)))
    });
        
    it('test_get_metric_name', () => {
        /* Test metric name extraction. */
        // Test with record that has instrument.name
        record = Mock()
        record.instrument = Mock()
        record.instrument.name = "test_metric"
        del record.name  // Ensure record.name doesn't exist
        
        result = self.exporter._get_metric_name(record)
        self.assertEqual(result, "test_metric")
        
        // Test with record that has direct name attribute
        record_with_name = Mock()
        record_with_name.name = "direct_metric"
        
        result2 = self.exporter._get_metric_name(record_with_name)
        self.assertEqual(result2, "direct_metric")
    });
        
    it('test_get_dimension_names', () => {
        /* Test dimension names extraction. */
        attributes = {"service.name": "test-service", "env": "prod", "region": "us-east-1"}
        
        result = self.exporter._get_dimension_names(attributes)
        
        // Should return all attribute keys
        self.assertEqual(set(result), {"service.name", "env", "region"})
    });
        
    it('test_get_attributes_key', () => {
        /* Test attributes key generation. */
        attributes = {"service": "test", "env": "prod"}
        
        result = self.exporter._get_attributes_key(attributes)
        
        // Should be a string representation of sorted attributes
        self.assertIsInstance(result, str)
        self.assertIn("service", result)
        self.assertIn("test", result)
        self.assertIn("env", result)
        self.assertIn("prod", result)
    });
        
    it('test_get_attributes_key_consistent', () => {
        /* Test that attributes key generation is consistent. */
        // Same attributes in different order should produce same key
        attrs1 = {"b": "2", "a": "1"}
        attrs2 = {"a": "1", "b": "2"}
        
        key1 = self.exporter._get_attributes_key(attrs1)
        key2 = self.exporter._get_attributes_key(attrs2)
        
        self.assertEqual(key1, key2)
    });
        
    it('test_group_by_attributes_and_timestamp', () => {
        /* Test grouping by attributes and timestamp. */
        record = Mock()
        record.attributes = {"env": "test"}
        timestamp_ms = 1234567890
        
        result = self.exporter._group_by_attributes_and_timestamp(record, timestamp_ms)
        
        // Should return a tuple with attributes key and timestamp
        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1], timestamp_ms)
    });
        
    it('test_generate_log_stream_name', () => {
        /* Test log stream name generation. */
        name1 = self.exporter._generate_log_stream_name()
        name2 = self.exporter._generate_log_stream_name()
        
        // Should generate unique names
        self.assertNotEqual(name1, name2)
        self.assertTrue(name1.startswith("otel-python-"))
        self.assertTrue(name2.startswith("otel-python-"))
    });
        
    it('test_normalize_timestamp', () => {
        /* Test timestamp normalization. */
        timestamp_ns = 1609459200000000000  // 2021-01-01 00:00:00 in nanoseconds
        expected_ms = 1609459200000  // Same time in milliseconds
        
        result = self.exporter._normalize_timestamp(timestamp_ns)
        self.assertEqual(result, expected_ms)
    });
        
    it('test_create_metric_record', () => {
        /* Test metric record creation. */
        record = self.exporter._create_metric_record("test_metric", "Count", "Test description")
        
        self.assertIsNotNone(record)
        self.assertIsNotNone(record.instrument)
        self.assertEqual(record.instrument.name, "test_metric")
        self.assertEqual(record.instrument.unit, "Count")
        self.assertEqual(record.instrument.description, "Test description")
    });
        
    it('test_convert_gauge', () => {
        /* Test gauge conversion. */
        metric = MockMetric("gauge_metric", "Count", "Gauge description")
        dp = MockDataPoint(value=42.5, attributes={"key": "value"})
        
        record, timestamp = self.exporter._convert_gauge(metric, dp)
        
        self.assertIsNotNone(record)
        self.assertEqual(record.instrument.name, "gauge_metric")
        self.assertEqual(record.value, 42.5)
        self.assertEqual(record.attributes, {"key": "value"})
        self.assertIsInstance(timestamp, int)
    });
        
    it('test_convert_sum', () => {
        /* Test sum conversion with the bug fix. */
        metric = MockMetric("sum_metric", "Count", "Sum description")
        dp = MockDataPoint(value=100.0, attributes={"env": "test"})
        
        record, timestamp = self.exporter._convert_sum(metric, dp)
        
        self.assertIsNotNone(record)
        self.assertEqual(record.instrument.name, "sum_metric")
        self.assertHasAttr(record, 'sum_data')
        self.assertEqual(record.sum_data.value, 100.0)
        self.assertEqual(record.attributes, {"env": "test"})
        self.assertIsInstance(timestamp, int)
    });
        
    it('test_convert_histogram', () => {
        /* Test histogram conversion. */
        metric = MockMetric("histogram_metric", "ms", "Histogram description")
        dp = MockHistogramDataPoint(
            count=10,
            sum_val=150.0,
            min_val=5.0,
            max_val=25.0,
            attributes={"region": "us-east-1"}
        )
        
        record, timestamp = self.exporter._convert_histogram(metric, dp)
        
        self.assertIsNotNone(record)
        self.assertEqual(record.instrument.name, "histogram_metric")
        self.assertHasAttr(record, 'histogram_data')
        
        expected_value = {
            "Count": 10,
            "Sum": 150.0,
            "Min": 5.0,
            "Max": 25.0
        }
        self.assertEqual(record.histogram_data.value, expected_value)
        self.assertEqual(record.attributes, {"region": "us-east-1"})
        self.assertIsInstance(timestamp, int)
    });
        
    it('test_convert_exp_histogram', () => {
        /* Test exponential histogram conversion. */
        metric = MockMetric("exp_histogram_metric", "s", "Exponential histogram description")
        dp = MockExpHistogramDataPoint(
            count=8,
            sum_val=64.0,
            min_val=2.0,
            max_val=32.0,
            attributes={"service": "api"}
        )
        
        record, timestamp = self.exporter._convert_exp_histogram(metric, dp)
        
        self.assertIsNotNone(record)
        self.assertEqual(record.instrument.name, "exp_histogram_metric")
        self.assertHasAttr(record, 'exp_histogram_data')
        
        exp_data = record.exp_histogram_data.value
        self.assertIn("Values", exp_data)
        self.assertIn("Counts", exp_data)
        self.assertEqual(exp_data["Count"], 8)
        self.assertEqual(exp_data["Sum"], 64.0)
        self.assertEqual(exp_data["Min"], 2.0)
        self.assertEqual(exp_data["Max"], 32.0)
        self.assertEqual(record.attributes, {"service": "api"})
        self.assertIsInstance(timestamp, int)
    });
        
    it('test_create_emf_log', () => {
        /* Test EMF log creation. */
        // Create test records
        gauge_record = self.exporter._create_metric_record("gauge_metric", "Count", "Gauge")
        gauge_record.value = 50.0
        gauge_record.timestamp = int(time.time() * 1000)
        gauge_record.attributes = {"env": "test"}
        
        sum_record = self.exporter._create_metric_record("sum_metric", "Count", "Sum")
        sum_record.sum_data = type('SumData', (), {})()
        sum_record.sum_data.value = 100.0
        sum_record.timestamp = int(time.time() * 1000)
        sum_record.attributes = {"env": "test"}
        
        records = [gauge_record, sum_record]
        resource = Resource.create({"service.name": "test-service"})
        
        result = self.exporter._create_emf_log(records, resource)
        
        self.assertIsInstance(result, dict)
        
        // Check that the result is JSON serializable
        json.dumps(result)  // Should not raise exception
    });
    
    //[]@patch('boto3.client')
    //[] def test_export_success(self, mock_boto_client):
    it('test_export_success', () => {
        /* Test successful export. */
        // Mock CloudWatch Logs client
        mock_client = Mock()
        mock_boto_client.return_value = mock_client
        mock_client.put_log_events.return_value = {"nextSequenceToken": "12345"}
        
        // Create empty metrics data to test basic export flow
        metrics_data = Mock()
        metrics_data.resource_metrics = []
        
        result = self.exporter.export(metrics_data)
        
        self.assertEqual(result, MetricExportResult.SUCCESS)
    });
        
    it('test_export_failure', () => {
        /* Test export failure handling. */
        // Create metrics data that will cause an exception during iteration
        metrics_data = Mock()
        // Make resource_metrics raise an exception when iterated over
        metrics_data.resource_metrics = Mock()
        metrics_data.resource_metrics.__iter__ = Mock(side_effect=Exception("Test exception"))
        
        result = self.exporter.export(metrics_data)
        
        self.assertEqual(result, MetricExportResult.FAILURE)
    });
    
    //[]@patch.object(CloudWatchEMFExporter, '_send_log_batch')
    //[] def test_force_flush_with_pending_events(self, mock_send_batch):
    it('test_force_flush_with_pending_events', () => {
        /* Test force flush functionality with pending events. */
        // Create a batch with events
        self.exporter._event_batch = self.exporter._create_event_batch()
        self.exporter._event_batch["logEvents"] = [{"message": "test", "timestamp": int(time.time() * 1000)}]
        
        result = self.exporter.force_flush()
        
        self.assertTrue(result)
        mock_send_batch.assert_called_once()
    });
        
    it('test_force_flush_no_pending_events', () => {
        /* Test force flush functionality with no pending events. */
        // No batch exists
        self.assertIsNone(self.exporter._event_batch)
        
        result = self.exporter.force_flush()
        
        self.assertTrue(result)
    });
    
    //[]@patch.object(CloudWatchEMFExporter, 'force_flush')
    //[] def test_shutdown(self, mock_force_flush):
    it('test_shutdown', () => {
        /* Test shutdown functionality. */
        mock_force_flush.return_value = True
        
        result = self.exporter.shutdown(timeout_millis=5000)
        
        self.assertTrue(result)
        mock_force_flush.assert_called_once_with(5000)
    });
    

    
    function _create_test_metrics_data(self) {
        /* Helper method to create test metrics data. */
        // Create a gauge metric data point
        gauge_dp = MockDataPoint(value=25.0, attributes={"env": "test"})
        
        // Create gauge metric data using MockGaugeData
        gauge_data = MockGaugeData([gauge_dp])
        
        // Create gauge metric
        gauge_metric = Mock()
        gauge_metric.name = "test_gauge"
        gauge_metric.unit = "Count"
        gauge_metric.description = "Test gauge"
        gauge_metric.data = gauge_data
        
        // Create scope metrics
        scope_metrics = MockScopeMetrics(metrics=[gauge_metric])
        
        // Create resource metrics
        resource_metrics = MockResourceMetrics(scope_metrics=[scope_metrics])
        
        // Create metrics data
        metrics_data = Mock()
        metrics_data.resource_metrics = [resource_metrics]
        
        return metrics_data
  }
});
