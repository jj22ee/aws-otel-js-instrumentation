// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ValueType } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import expect from 'expect';
import * as sinon from 'sinon';
import {
  PutLogEventsCommandInput,
  CloudWatchLogs,
  PutLogEventsCommandOutput,
  CreateLogGroupCommandInput,
  CreateLogGroupCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudWatchEMFExporter,
  createEmfExporter,
  CW_MAX_EVENT_PAYLOAD_BYTES,
  CW_MAX_REQUEST_EVENT_COUNT,
  CW_MAX_REQUEST_PAYLOAD_BYTES,
  CW_TRUNCATED_SUFFIX,
  Record,
  RECORD_DATA_TYPES,
  RecordValue,
} from '../src/exporter/otlp/aws/metrics/otlp-aws-emf-exporter';
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
  ResourceMetrics,
  SumMetricData,
} from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';
import { HttpHandlerOptions } from '@smithy/protocol-http';

describe('TestBatchProcessing', () => {
  let exporter: CloudWatchEMFExporter;

  beforeEach(() => {
    /* Set up test fixtures. */
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });

    exporter = new CloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('test_create_event_batch', () => {
    /* Test event batch creation. */
    const batch = exporter['createEventBatch']();

    expect(batch['logEvents']).toEqual([]);
    expect(batch['byteTotal']).toEqual(0);
    expect(batch['minTimestampMs']).toEqual(0);
    expect(batch['maxTimestampMs']).toEqual(0);
    expect(typeof batch['createdTimestampMs']).toEqual('number');
  });

  it('test_validate_log_event_valid', () => {
    /* Test log event validation with valid event. */
    const log_event = {
      message: 'test message',
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](log_event);
    expect(result).toBeTruthy();
  });

  it('test_validate_log_event_empty_message', () => {
    /* Test log event validation with empty message. */
    const log_event = {
      message: '',
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](log_event);
    expect(result).toBeFalsy();
  });

  it('test_validate_log_event_oversized_message', () => {
    /* Test log event validation with oversized message. */
    // Create a message larger than the maximum allowed size
    const large_message = 'x'.repeat(CW_MAX_EVENT_PAYLOAD_BYTES + 100);
    const log_event = {
      message: large_message,
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](log_event);
    expect(result).toBeTruthy(); // Should still be valid after truncation
    // Check that message was truncated
    expect(log_event['message'].length).toBeLessThan(large_message.length);
    expect(log_event['message'].endsWith(CW_TRUNCATED_SUFFIX)).toBeTruthy();
  });

  it('test_validate_log_event_old_timestamp', () => {
    /* Test log event validation with very old timestamp. */
    // Timestamp from 15 days ago
    const old_timestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const log_event = {
      message: 'test message',
      timestamp: old_timestamp,
    };

    const result = exporter['validateLogEvent'](log_event);
    expect(result).toBeFalsy();
  });

  it('test_validate_log_event_future_timestamp', () => {
    /* Test log event validation with future timestamp. */
    // Timestamp 3 hours in the future
    const future_timestamp = Date.now() + 3 * 60 * 60 * 1000;
    const log_event = {
      message: 'test message',
      timestamp: future_timestamp,
    };

    const result = exporter['validateLogEvent'](log_event);
    expect(result).toBeFalsy();
  });

  it('test_event_batch_exceeds_limit_by_count', () => {
    /* Test batch limit checking by event count. */
    const batch = exporter['createEventBatch']();
    // Simulate batch with maximum events
    batch['logEvents'] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({ message: 'test' });

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('test_event_batch_exceeds_limit_by_size', () => {
    /* Test batch limit checking by byte size. */
    const batch = exporter['createEventBatch']();
    batch['byteTotal'] = CW_MAX_REQUEST_PAYLOAD_BYTES - 50;

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('test_event_batch_within_limits', () => {
    /* Test batch limit checking within limits. */
    const batch = exporter['createEventBatch']();
    batch['logEvents'] = Array(10).fill({ message: 'test' });
    batch['byteTotal'] = 1000;

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeFalsy();
  });

  it('test_is_batch_active_new_batch', () => {
    /* Test batch activity check for new batch. */
    const batch = exporter['createEventBatch']();
    const current_time = Date.now();

    const result = exporter['isBatchActive'](batch, current_time);
    expect(result).toBeTruthy();
  });

  it('test_is_batch_active_24_hour_span', () => {
    /* Test batch activity check for 24+ hour span. */
    const batch = exporter['createEventBatch']();
    const current_time = Date.now();
    batch['minTimestampMs'] = current_time;
    batch['maxTimestampMs'] = current_time;

    // Test with timestamp 25 hours in the future
    const future_timestamp = current_time + 25 * 60 * 60 * 1000;

    const result = exporter['isBatchActive'](batch, future_timestamp);
    expect(result).toBeFalsy();
  });

  it('test_append_to_batch', () => {
    /* Test appending log event to batch. */
    const batch = exporter['createEventBatch']();
    const log_event = {
      message: 'test message',
      timestamp: Date.now(),
    };
    const event_size = 100;

    exporter['appendToBatch'](batch, log_event, event_size);

    expect(batch['logEvents'].length).toEqual(1);
    expect(batch['byteTotal']).toEqual(event_size);
    expect(batch['minTimestampMs']).toEqual(log_event['timestamp']);
    expect(batch['maxTimestampMs']).toEqual(log_event['timestamp']);
  });

  it('test_sort_log_events', () => {
    /* Test sorting log events by timestamp. */
    const batch = exporter['createEventBatch']();
    const current_time = Date.now();

    // Add events with timestamps in reverse order
    const events = [
      { message: 'third', timestamp: current_time + 2000 },
      { message: 'first', timestamp: current_time },
      { message: 'second', timestamp: current_time + 1000 },
    ];

    batch['logEvents'] = [...events];
    exporter['sortLogEvents'](batch);

    // Check that events are now sorted by timestamp
    expect(batch['logEvents'][0]['message']).toEqual('first');
    expect(batch['logEvents'][1]['message']).toEqual('second');
    expect(batch['logEvents'][2]['message']).toEqual('third');
  });
});

describe('TestCreateEMFExporter', () => {
  /* Test the create_emf_exporter function. */

  beforeEach(() => {
    /* Set up test fixtures. */
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('test_create_emf_exporter_default_args', async () => {
    const exporter = createEmfExporter();

    await exporter['logGroupExistsPromise'];

    expect(exporter).toBeInstanceOf(CloudWatchEMFExporter);
    expect(exporter['namespace']).toEqual('OTelJavaScript');
  });

  it('test_create_emf_exporter_custom_args', () => {
    /* Test creating exporter with custom arguments. */

    const exporter = createEmfExporter('CustomNamespace', '/custom/log/group', undefined, 'us-west-2', {});

    expect(exporter).toBeInstanceOf(CloudWatchEMFExporter);
    expect(exporter['namespace']).toEqual('CustomNamespace');
    expect(exporter['logGroupName']).toEqual('/custom/log/group');
  });
});

describe('TestSendLogBatch', () => {
  let exporter: CloudWatchEMFExporter;
  let createLogGroupStub: sinon.SinonStub<
    [
      args: CreateLogGroupCommandInput,
      options: HttpHandlerOptions,
      cb: (err: any, data?: CreateLogGroupCommandOutput) => void
    ],
    void
  >;
  let putLogEventsStub: sinon.SinonStub<
    [
      args: PutLogEventsCommandInput,
      options: HttpHandlerOptions,
      cb: (err: any, data?: PutLogEventsCommandOutput) => void
    ],
    void
  >;

  beforeEach(async () => {
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    createLogGroupStub = sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogStream').callsFake(input => {
      return {};
    });
    putLogEventsStub = sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });

    // // Create a proper exception class for ResourceAlreadyExistsException
    // class ResourceAlreadyExistsException(Exception):
    //     pass

    // self.mock_client.exceptions.ResourceAlreadyExistsException = ResourceAlreadyExistsException

    // // Mock session to return our mock client
    // let mock_session_instance = Mock()
    // mock_session.return_value = mock_session_instance
    // mock_session_instance.client.return_value = self.mock_client

    exporter = new CloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
    await exporter['logGroupExistsPromise'];
  });

  afterEach(() => {
    sinon.restore();
  });

  it('test_send_log_batch_empty', async () => {
    /* Test sending empty log batch. */

    const batch = exporter['createEventBatch']();
    // Should not make any AWS calls for empty batch
    await exporter['sendLogBatch'](batch);

    sinon.assert.notCalled(putLogEventsStub);
  });

  it('test_send_log_batch_with_events', async () => {
    /* Test sending log batch with events. */
    const batch = exporter['createEventBatch']();
    const current_time = Date.now();

    // Add some log events
    const events = [
      { message: 'first message', timestamp: current_time },
      { message: 'second message', timestamp: current_time + 1000 },
    ];

    for (const event of events) {
      batch['logEvents'].push(event);
    }

    await exporter['sendLogBatch'](batch);

    sinon.assert.calledOnce(putLogEventsStub);

    const putLogEventsCallArg1 = putLogEventsStub.getCall(0).args[0];
    expect(putLogEventsCallArg1.logGroupName).toEqual('test-log-group');
    expect(putLogEventsCallArg1.logEvents?.length).toEqual(2);
  });

  it('test_send_log_batch_sorts_events', async () => {
    /* Test that log batch sorting works correctly. */
    const batch = exporter['createEventBatch']();
    const current_time = Date.now();

    // Add events in reverse timestamp order
    const events = [
      { message: 'second', timestamp: current_time + 1000 },
      { message: 'first', timestamp: current_time },
    ];

    for (const event of events) {
      batch['logEvents'].push(event);
    }

    await exporter['sendLogBatch'](batch);

    // Verify events were sorted by timestamp
    const putLogEventsCallArg1 = putLogEventsStub.getCall(0).args[0];
    const sortedEvents = putLogEventsCallArg1.logEvents;

    expect(sortedEvents?.length).toEqual(2);
    expect(sortedEvents ? sortedEvents[0].message : undefined).toEqual('first');
    expect(sortedEvents ? sortedEvents[1].message : undefined).toEqual('second');
  });

  // First exception is handled, second exception is thrown
  it('test_send_log_batch_handles_exceptions', async () => {
    // Need to update these stubs for this test to throw errors
    createLogGroupStub.restore();
    putLogEventsStub.restore();
    /* Test that send_log_batch handles exceptions properly. */
    const batch = exporter['createEventBatch']();
    batch['logEvents'].push({ message: 'test', timestamp: Date.now() });

    createLogGroupStub = sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      throw Error('AWS error');
    });
    putLogEventsStub = sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      throw Error('AWS test error 123');
    });

    //[][][] Check with Min, we want to confirm NOT to throw right?
    await expect(exporter['sendLogBatch'](batch)).rejects.toThrow('AWS test error 123');
  });
});

describe('TestSendLogEvent', () => {
  //[] class TestSendLogEvent(unittest.TestCase):
  /* Test individual log event sending functionality. */
  let exporter: CloudWatchEMFExporter;

  beforeEach(() => {
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogStream').callsFake(input => {
      return {};
    });
    sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });
    exporter = new CloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('test_send_log_event_creates_batch', async () => {
    /* Test that sending first log event creates a batch. */
    const log_event = {
      message: 'test message',
      timestamp: Date.now(),
    };

    // Initially no batch should exist
    expect(exporter['eventBatch']).toBeUndefined();

    await exporter['sendLogEvent'](log_event);

    // Batch should now be created
    expect(exporter['eventBatch']).not.toBeUndefined();
    expect(exporter['eventBatch'] ? exporter['eventBatch']['logEvents'].length : -1).toEqual(1);
  });

  it('test_send_log_event_invalid_event', async () => {
    /* Test sending invalid log event. */
    const log_event = {
      message: '', // Empty message should be invalid
      timestamp: Date.now(),
    };

    await exporter['sendLogEvent'](log_event);

    // Batch should not be created for invalid event
    expect(exporter['eventBatch']).toBeUndefined();
  });

  it('test_send_log_event_triggers_batch_send', async () => {
    /* Test that exceeding batch limits triggers batch send. */

    const sendLogBatchStub = sinon.stub(exporter, <any>'sendLogBatch');

    // First, add an event to create a batch
    const log_event = {
      message: 'test message',
      timestamp: Date.now(),
    };
    await exporter['sendLogEvent'](log_event);

    // Now simulate batch being at limit
    exporter['eventBatch']!['logEvents'] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({ message: 'test' });

    // Send another event that should trigger batch send
    await exporter['sendLogEvent'](log_event);

    // Verify batch was sent
    sinon.assert.calledOnce(sendLogBatchStub);
  });
});

describe('TestCloudWatchEMFExporter', () => {
  //[] class TestCloudWatchEMFExporter(unittest.TestCase):
  /* Test CloudWatchEMFExporter class. */
  let exporter: CloudWatchEMFExporter;

  beforeEach(() => {
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });

    exporter = new CloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('test_initialization', () => {
    /* Test exporter initialization. */
    expect(exporter['namespace']).toEqual('TestNamespace');
    expect(exporter['logGroupName']).not.toBeUndefined();
    expect(exporter['logStreamName']).not.toBeUndefined();
    expect(exporter['aggregationTemporality']).not.toBeUndefined();
  });

  it('test_initialization_with_custom_params', () => {
    /* Test exporter initialization with custom parameters. */

    const newExporter = new CloudWatchEMFExporter(
      'CustomNamespace',
      'custom-log-group',
      'custom-stream',
      'us-west-2',
      AggregationTemporality.DELTA,
      {}
    );

    expect(newExporter['namespace']).toEqual('CustomNamespace');
    expect(newExporter['logGroupName']).toEqual('custom-log-group');
    expect(newExporter['logStreamName']).toEqual('custom-stream');
  });

  it('test_get_unit_mapping', () => {
    /* Test unit mapping functionality. */
    // Test known units
    expect(exporter['getUnit']({ name: 'testName', unit: 'ms', description: 'testDescription' })).toEqual(
      'Milliseconds'
    );
    expect(exporter['getUnit']({ name: 'testName', unit: 's', description: 'testDescription' })).toEqual('Seconds');
    expect(exporter['getUnit']({ name: 'testName', unit: 'By', description: 'testDescription' })).toEqual('Bytes');
    expect(exporter['getUnit']({ name: 'testName', unit: '%', description: 'testDescription' })).toEqual('Percent');

    // Test unknown unit
    expect(exporter['getUnit']({ name: 'testName', unit: 'unknown', description: 'testDescription' })).toEqual(
      'unknown'
    );

    // Test empty unit (should return None due to falsy check)
    expect(exporter['getUnit']({ name: 'testName', unit: '', description: 'testDescription' })).toBeUndefined();

    //[][not needed...] Test undefined unit
    expect(
      exporter['getUnit']({ name: 'testName', unit: undefined, description: 'testDescription' } as any)
    ).toBeUndefined();
  });

  it('test_get_metric_name', () => {
    /* Test metric name extraction. */
    // Test with record that has instrument.name
    const record: Record = {
      instrument: {
        name: 'test_metric',
        unit: 'ms',
        description: 'test description',
      },
      timestamp: Date.now(),
      attributes: {},
    };

    const result = exporter['getMetricName'](record);
    expect(result).toEqual('test_metric');

    // Test with record that has direct name attribute
    const record_with_name: Record = {
      name: 'direct_metric',
      timestamp: Date.now(),
      attributes: {},
      instrument: {
        name: 'indirect_metric',
        unit: 'ms',
        description: 'test description',
      },
    };

    const result2 = exporter['getMetricName'](record_with_name);
    expect(result2).toEqual('direct_metric');
  });

  it('test_get_dimension_names', () => {
    /* Test dimension names extraction. */
    const attributes = { 'service.name': 'test-service', env: 'prod', region: 'us-east-1' };

    const result = exporter['getDimensionNames'](attributes);

    // Should return all attribute keys
    expect(result).toContain('service.name');
    expect(result).toContain('env');
    expect(result).toContain('region');
  });

  it('test_get_attributes_key', () => {
    /* Test attributes key generation. */
    const attributes = { service: 'test', env: 'prod' };

    const result = exporter['getAttributesKey'](attributes);

    // Should be a string representation of sorted attributes
    expect(typeof result).toEqual('string');
    expect(result).toContain('service');
    expect(result).toContain('test');
    expect(result).toContain('env');
    expect(result).toContain('prod');
  });

  it('test_get_attributes_key_consistent', () => {
    /* Test that attributes key generation is consistent. */
    // Same attributes in different order should produce same key
    const attrs1 = { b: '2', a: '1' };
    const attrs2 = { a: '1', b: '2' };

    const key1 = exporter['getAttributesKey'](attrs1);
    const key2 = exporter['getAttributesKey'](attrs2);

    expect(key1).toEqual(key2);
  });

  it('test_group_by_attributes_and_timestamp', () => {
    /* Test grouping by attributes and timestamp. */
    const record: Record = {
      instrument: {
        name: 'test_metric',
        unit: 'ms',
        description: 'test description',
      },
      timestamp: Date.now(),
      attributes: { env: 'test' },
    };
    const timestamp_ms = 1234567890;

    const result = exporter['groupByAttributesAndTimestamp'](record, timestamp_ms);

    // Should return a tuple with attributes key and timestamp
    expect(result.length).toEqual(2);
    expect(typeof result[0]).toEqual('string');
    expect(typeof result[1]).toEqual('number');
    expect(result[1]).toEqual(timestamp_ms);
  });

  it('test_generate_log_stream_name', () => {
    /* Test log stream name generation. */
    const name1 = exporter['generateLogStreamName']();
    const name2 = exporter['generateLogStreamName']();

    // Should generate unique names
    expect(name1).not.toEqual(name2);
    expect(name1.startsWith('otel-javascript-')).toBeTruthy();
    expect(name2.startsWith('otel-javascript-')).toBeTruthy();
  });

  it('test_normalize_timestamp', () => {
    /* Test timestamp normalization. */
    const timestamp_ns = 1609459200000000000; // 2021-01-01 00:00:00 in nanoseconds
    const expected_ms = 1609459200000; // Same time in milliseconds

    const result = exporter['normalizeTimestamp']([0, timestamp_ns]);
    expect(result).toEqual(expected_ms);
  });

  it('test_create_metric_record', () => {
    /* Test metric record creation. */
    const record = exporter['createMetricRecord']('test_metric', 'Count', 'Test description');

    expect(record).not.toBeUndefined();
    expect(record.instrument).not.toBeUndefined();
    expect(record.instrument.name).toEqual('test_metric');
    expect(record.instrument.unit).toEqual('Count');
    expect(record.instrument.description).toEqual('Test description');
  });

  it('test_convert_gauge', () => {
    const dp: DataPoint<number> = {
      startTime: [0, 0],
      endTime: [1, 0],
      attributes: { key: 'value' },
      value: 42.5,
    };

    /* Test gauge conversion. */
    const metric: GaugeMetricData = {
      dataPointType: DataPointType.GAUGE,
      descriptor: {
        name: 'test_gauge_metric_data',
        unit: 'Count',
        description: 'Gauge description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.GAUGE,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const [record, timestamp] = exporter['convertGauge'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.instrument.name).toEqual('test_gauge_metric_data');
    expect(record.value).toEqual(42.5);
    expect(record.attributes).toEqual({ key: 'value' });
    expect(typeof timestamp).toEqual('number');
  });

  it('test_convert_sum', () => {
    /* Test sum conversion with the bug fix. */
    const dp: DataPoint<number> = {
      startTime: [0, 0],
      endTime: [1, 0],
      attributes: { env: 'test' },
      value: 100.0,
    };

    /* Test gauge conversion. */
    const metric: SumMetricData = {
      dataPointType: DataPointType.SUM,
      descriptor: {
        name: 'sum_metric',
        unit: 'Count',
        description: 'Sum description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.COUNTER,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
      isMonotonic: true,
    };

    const [record, timestamp] = exporter['convertSum'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.instrument.name).toEqual('sum_metric');
    expect(record).toHaveProperty('sumData');
    expect(record.sumData?.value).toEqual(100.0);
    expect(record.attributes).toEqual({ env: 'test' });
    expect(typeof timestamp).toEqual('number');
  });

  it('test_convert_histogram', () => {
    /* Test histogram conversion. */
    const dp: DataPoint<Histogram> = {
      startTime: [0, 0],
      endTime: [1, 0],
      attributes: { region: 'us-east-1' },
      value: {
        count: 10,
        sum: 150.0,
        min: 5.0,
        max: 25.0,
        buckets: {
          boundaries: [],
          counts: [],
        },
      },
    };

    /* Test gauge conversion. */
    const metric: HistogramMetricData = {
      dataPointType: DataPointType.HISTOGRAM,
      descriptor: {
        name: 'histogram_metric',
        unit: 'ms',
        description: 'Histogram description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.HISTOGRAM,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const [record, timestamp] = exporter['convertHistogram'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.instrument.name).toEqual('histogram_metric');
    expect(record).toHaveProperty('histogramData');

    const expected_value = {
      Count: 10,
      Sum: 150.0,
      Min: 5.0,
      Max: 25.0,
    };
    expect(record.histogramData?.value).toEqual(expected_value);
    expect(record.attributes).toEqual({ region: 'us-east-1' });
    expect(typeof timestamp).toEqual('number');
  });

  it('test_convert_exp_histogram', () => {
    /* Test exponential histogram conversion. */
    // let metric = MockMetric("exp_histogram_metric", "s", "Exponential histogram description")
    //[][][] let dp: DataPoint<ExponentialHistogram> = MockExpHistogramDataPoint(
    //     count=8,
    //     sum_val=64.0,
    //     min_val=2.0,
    //     max_val=32.0,
    //     attributes={"service": "api"}
    // )

    const dp: DataPoint<ExponentialHistogram> = {
      startTime: [0, 0],
      endTime: [1, 0],
      attributes: { service: 'api' },
      value: {
        count: 8,
        sum: 64.0,
        min: 2.0,
        max: 32.0,
        scale: 1,
        zeroCount: 1,
        positive: {
          offset: 1,
          bucketCounts: [],
        },
        negative: {
          offset: 2,
          bucketCounts: [],
        },
      },
    };

    /* Test gauge conversion. */
    const metric: ExponentialHistogramMetricData = {
      dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
      descriptor: {
        name: 'exp_histogram_metric',
        unit: 's',
        description: 'Exponential histogram description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.HISTOGRAM,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const [record, timestamp] = exporter['convertExpHistogram'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.instrument.name).toEqual('exp_histogram_metric');
    expect(record).toHaveProperty('expHistogramData');

    const exp_data = record.expHistogramData?.value;
    expect(exp_data).toHaveProperty('Values');
    expect(exp_data).toHaveProperty('Counts');
    expect((exp_data as RecordValue)['Count']).toEqual(8);
    expect((exp_data as RecordValue)['Sum']).toEqual(64.0);
    expect((exp_data as RecordValue)['Min']).toEqual(2.0);
    expect((exp_data as RecordValue)['Max']).toEqual(32.0);
    expect(record.attributes).toEqual({ service: 'api' });
    expect(typeof timestamp).toEqual('number');
  });

  it('test_create_emf_log', () => {
    /* Test EMF log creation. */
    // Create test records
    const gauge_record: Record = {
      ...exporter['createMetricRecord']('gauge_metric', 'Count', 'Gauge'),
      value: 50.0,
      timestamp: Date.now(),
      attributes: { env: 'test' },
    };

    const sum_record: Record = {
      ...exporter['createMetricRecord']('sum_metric', 'Count', 'Sum'),
      sumData: {
        value: 100.0,
        type: RECORD_DATA_TYPES.SUM_DATA,
      },
      timestamp: Date.now(),
      attributes: { env: 'test' },
    };

    const records = [gauge_record, sum_record];
    const resource = new Resource({ 'service.name': 'test-service' });

    const result = exporter['createEmfLog'](records, resource);

    expect(result).toHaveProperty('_aws');
    expect(result._aws.CloudWatchMetrics[0].Namespace).toEqual('TestNamespace');
    expect(result._aws.CloudWatchMetrics[0].Dimensions[0][0]).toEqual('env');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Name).toEqual('gauge_metric');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Unit).toEqual('Count');
    expect(result._aws.CloudWatchMetrics[0].Metrics[1].Name).toEqual('sum_metric');
    expect(result._aws.CloudWatchMetrics[0].Metrics[1].Unit).toEqual('Count');
    expect(result).toHaveProperty('Version', '1');
    expect(result['resource.service.name']).toEqual('test-service'); // toHaveProperty() doesn't work with '.'
    expect(result).toHaveProperty('gauge_metric', 50);
    expect(result).toHaveProperty('sum_metric', 100);
    expect(result).toHaveProperty('env', 'test');

    // // Sanity check that the result is JSON serializable, and doesn't throw error
    JSON.stringify(result);
  });

  it('test_export_success', done => {
    /* Test successful export. */
    // Mock CloudWatch Logs client
    sinon.stub(exporter['logsClient'], 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });

    // Create empty metrics data to test basic export flow
    const resourceMetricsData: ResourceMetrics = {
      resource: new Resource({}),
      scopeMetrics: [],
    };

    exporter.export(resourceMetricsData, result => {
      expect(result.code).toEqual(ExportResultCode.SUCCESS);
      done();
    });
  });

  it('test_export_failure', done => {
    /* Test export failure handling. */
    // Create metrics data that will cause an exception during iteration
    const metrics_data: ResourceMetrics = {
      resource: new Resource({}),
      scopeMetrics: [undefined as any], // will cause an error to throw
    };

    exporter.export(metrics_data, result => {
      expect(result.code).toEqual(ExportResultCode.FAILED);
      done();
    });
  });

  it('test_force_flush_with_pending_events', async () => {
    /* Test force flush functionality with pending events. */

    const sendLogBatchStub = sinon.stub(exporter, <any>'sendLogBatch');

    // Create a batch with events
    exporter['eventBatch'] = exporter['createEventBatch']();
    exporter['eventBatch']['logEvents'] = [{ message: 'test', timestamp: Date.now() }];

    await expect(exporter.forceFlush()).resolves.not.toThrow();
    sinon.assert.calledOnce(sendLogBatchStub);
  });

  it('test_force_flush_no_pending_events', async () => {
    /* Test force flush functionality with no pending events. */
    // No batch exists
    expect(exporter['eventBatch']).toBeUndefined();

    await expect(exporter.forceFlush()).resolves.not.toThrow();
  });

  it('test_shutdown', async () => {
    /* Test shutdown functionality. */

    const forceFlushStub = sinon.stub(exporter, 'forceFlush');

    // Ensure this call doesn't reject
    await exporter.shutdown();

    sinon.assert.calledOnce(forceFlushStub);
  });

  //[][]     function _create_test_metrics_data(self) {
  //         /* Helper method to create test metrics data. */
  //         // Create a gauge metric data point
  //         let gauge_dp = MockDataPoint(value=25.0, attributes={"env": "test"})

  //         // Create gauge metric data using MockGaugeData
  //         let gauge_data = MockGaugeData([gauge_dp])

  //         // Create gauge metric
  //         let gauge_metric = Mock()
  //         gauge_metric.name = "test_gauge"
  //         gauge_metric.unit = "Count"
  //         gauge_metric.description = "Test gauge"
  //         gauge_metric.data = gauge_data

  //         // Create scope metrics
  //         let scope_metrics = MockScopeMetrics(metrics=[gauge_metric])

  //         // Create resource metrics
  //         let resource_metrics = MockResourceMetrics(scope_metrics=[scope_metrics])

  //         // Create metrics data
  //         let metrics_data = Mock()
  //         metrics_data.resource_metrics = [resource_metrics]

  //         return metrics_data
  //   }
});
