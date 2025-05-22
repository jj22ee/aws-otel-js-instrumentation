// from unittest import { Attributes } from "@opentelemetry/api"
// import TestCase
// from unittest.mock import MagicMock, call, patch

import * as api from '@opentelemetry/api-events';
import { Attributes, AttributeValue, SpanContext, SpanKind } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import expect from "expect";
import { LLOHandler } from "../src/llo-handler";
import { EventLogger, EventLoggerProvider } from "@opentelemetry/sdk-events";
import { Logger, LoggerOptions, LogRecord } from '@opentelemetry/api-logs';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import * as sinon from 'sinon';
import { Mutable } from '../src/utils';


// from amazon.opentelemetry.distro.llo_handler import LLOHandler
// from opentelemetry._events import Event
// from opentelemetry.sdk._logs import LoggerProvider
// from opentelemetry.sdk.trace import ReadableSpan, SpanContext
// from opentelemetry.trace import SpanKind, TraceFlags, TraceState


describe('LLOHandlerTest', () => {
    let logger_mock: Logger = {
        emit: (logRecord: LogRecord) => {}
    }
    let logger_provider_mock: LoggerProvider;
    let event_logger_mock: api.EventLogger;
    let event_logger_provider_mock: EventLoggerProvider;
    let lloHandler: LLOHandler;

    //[] let event_logger_provider_mock_record: sinon.SinonStub<[name: string, version?: string | undefined, options?: api.EventLoggerOptions | undefined], api.EventLogger>

    before(() => { 
        // logger_provider_mock = MagicMock(spec=LoggerProvider)
        // self.event_logger_mock = MagicMock()
        // event_logger_provider_mock = MagicMock()
        // event_logger_provider_mock.get_event_logger.return_value = self.event_logger_mock

        logger_provider_mock = new LoggerProvider()
        logger_provider_mock.getLogger = (name: string, version?: string, options?: LoggerOptions) => {
            return logger_mock;
        }

        lloHandler = new LLOHandler(logger_provider_mock);
        event_logger_provider_mock = lloHandler["eventLoggerProvider"];
        event_logger_mock = lloHandler["eventLogger"];

        // event_logger_provider_mock.getEventLogger = (name: string, version?: string, options?: api.EventLoggerOptions) => {
        //     return event_logger_mock;
        // }

        // with patch(
        //     "amazon.opentelemetry.distro.llo_handler.EventLoggerProvider", return_value=event_logger_provider_mock
        // ):
        //     lloHandler = LLOHandler(logger_provider_mock)
    });

    afterEach(() => {
        sinon.restore();
    })

    function _create_mock_span(attributes: Attributes | undefined = undefined, kind=SpanKind.INTERNAL): Mutable<ReadableSpan> {
        // Configure spanData
        const mockSpanData: ReadableSpan = {
            name: 'spanName',
            kind: kind,
            spanContext: () => {
                const spanContext: SpanContext = {
                traceId: '00000000000000000000000000000008',
                spanId: '0000000000000009',
                traceFlags: 0,
                };
                return spanContext;
            },
            startTime: [1234567890, 0],
            endTime: [1234567891, 0],
            status: { code: 0 },
            attributes: {},
            links: [],
            events: [],
            duration: [0, 1],
            ended: true,
            resource: new Resource({}),
            instrumentationLibrary: { name: 'mockedLibrary' },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
        };
        if (attributes) {
            (mockSpanData as any).attributes = attributes;
        }
        return mockSpanData;
    }

    //[] function _create_mock_span(attributes: Attributes | undefined = undefined, kind=SpanKind.INTERNAL) {
    //     /*
    //     Helper method to create a mock span with given attributes
    //     */
    //     if attributes is None:
    //         attributes = {}

    //     let span_context = SpanContext(
    //         trace_id=0x123456789ABCDEF0123456789ABCDEF0,
    //         span_id=0x123456789ABCDEF0,
    //         is_remote=False,
    //         trace_flags=TraceFlags.SAMPLED,
    //         trace_state=TraceState.get_default(),
    //     )

    //     let mock_span = MagicMock(spec=ReadableSpan)
    //     mock_span.context = span_context
    //     mock_span.attributes = attributes
    //     mock_span.kind = kind
    //     mock_span.start_time = 1234567890

    //     return mock_span
    // }
    
    it('test_init', () => {
        /*
        Test initialization of LLOHandler
        */
        expect(lloHandler["loggerProvider"]).toEqual(logger_provider_mock)
        expect(lloHandler["eventLoggerProvider"]).toEqual(event_logger_provider_mock)

        //[] event_logger_provider_mock.getEventLogger.assert_called_once_with("gen_ai.events")
        expect((event_logger_mock as EventLogger)["_logger"]).toBe(logger_mock);
    });
    
    it('test_is_llo_attribute_match', () => {
        /*
        Test _is_llo_attribute method with matching patterns
        */
        expect(lloHandler["isLloAttribute"]("gen_ai.prompt.0.content")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("gen_ai.prompt.123.content")).toBeTruthy()
    });
    
    it('test_is_llo_attribute_no_match', () => {
        /*
        Test _is_llo_attribute method with non-matching patterns
        */
        expect(lloHandler["isLloAttribute"]("gen_ai.prompt.content")).toBeFalsy()
        expect(lloHandler["isLloAttribute"]("gen_ai.prompt.abc.content")).toBeFalsy()
        expect(lloHandler["isLloAttribute"]("some.other.attribute")).toBeFalsy()
    });
    
    it('test_is_llo_attribute_traceloop_match', () => {
        /*
        Test _is_llo_attribute method with Traceloop patterns
        */
        // Test exact matches for Traceloop attributes
        expect(lloHandler["isLloAttribute"]("traceloop.entity.input")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("traceloop.entity.output")).toBeTruthy()
    });
    
    it('test_is_llo_attribute_openlit_match', () => {
        /*
        Test _is_llo_attribute method with OpenLit patterns
        */
        // Test exact matches for direct OpenLit attributes
        expect(lloHandler["isLloAttribute"]("gen_ai.prompt")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("gen_ai.completion")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("gen_ai.content.revised_prompt")).toBeTruthy()
    });
    
    it('test_is_llo_attribute_openinference_match', () => {
        /*
        Test _is_llo_attribute method with OpenInference patterns
        */
        // Test exact matches
        expect(lloHandler["isLloAttribute"]("input.value")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("output.value")).toBeTruthy()

        // Test regex matches
        expect(lloHandler["isLloAttribute"]("llm.input_messages.0.message.content")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("llm.output_messages.123.message.content")).toBeTruthy()
    });
    
    it('test_is_llo_attribute_crewai_match', () => {
        /*
        Test _is_llo_attribute method with CrewAI patterns
        */
        // Test exact match for CrewAI attributes (handled by Traceloop and OpenLit)
        expect(lloHandler["isLloAttribute"]("gen_ai.agent.actual_output")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("gen_ai.agent.human_input")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("crewai.crew.tasks_output")).toBeTruthy()
        expect(lloHandler["isLloAttribute"]("crewai.crew.result")).toBeTruthy()
    });
    
    it('test_filter_attributes', () => {
        /*
        Test _filter_attributes method
        */
        let attributes = {
            "gen_ai.prompt.0.content": "test content",
            "gen_ai.prompt.0.role": "user",
            "normal.attribute": "value",
            "another.normal.attribute": 123,
        }

        let filtered = lloHandler["filterAttributes"](attributes)

        expect(filtered["gen_ai.prompt.0.content"]).toBeUndefined();
        expect(filtered["gen_ai.prompt.0.role"]).toBeDefined();
        expect(filtered["normal.attribute"]).toBeDefined();
        expect(filtered["another.normal.attribute"]).toBeDefined();

        //[]
        // self.assertNotIn("gen_ai.prompt.0.content", filtered)
        // self.assertIn("gen_ai.prompt.0.role", filtered)
        // self.assertIn("normal.attribute", filtered)
        // self.assertIn("another.normal.attribute", filtered)
    });
    
    it('testextractGenAiPromptEvents_system_role', () => {
        /*
        Test extractGenAiPromptEvents with system role
        */
        let attributes = {
            "gen_ai.prompt.0.content": "system instruction",
            "gen_ai.prompt.0.role": "system",
            "gen_ai.system": "openai",
        }

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractGenAiPromptEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.system.message")
        expect((event as any).data["content"]).toEqual("system instruction")
        expect((event as any).data["role"]).toEqual("system")
        expect(event.attributes!["gen_ai.system"]).toEqual("openai")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.prompt.0.content")
    });
    
    it('testextractGenAiPromptEvents_user_role', () => {
        /*
        Test extractGenAiPromptEvents with user role
        */
        let attributes = {
            "gen_ai.prompt.0.content": "user question",
            "gen_ai.prompt.0.role": "user",
            "gen_ai.system": "anthropic",
        }

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractGenAiPromptEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.user.message")
        expect((event as any).data["content"]).toEqual("user question")
        expect((event as any).data["role"]).toEqual("user")
        expect(event.attributes!["gen_ai.system"]).toEqual("anthropic")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.prompt.0.content")
    });
    
    it('testextractGenAiPromptEvents_assistant_role', () => {
        /*
        Test extractGenAiPromptEvents with assistant role
        */
        let attributes = {
            "gen_ai.prompt.1.content": "assistant response",
            "gen_ai.prompt.1.role": "assistant",
            "gen_ai.system": "anthropic",
        }

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractGenAiPromptEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.assistant.message")
        expect((event as any).data["content"]).toEqual("assistant response")
        expect((event as any).data["role"]).toEqual("assistant")
        expect(event.attributes!["gen_ai.system"]).toEqual("anthropic")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.prompt.1.content")
    });
    
    it('testextractGenAiPromptEvents_function_role', () => {
        /*
        Test extractGenAiPromptEvents with function role
        */
        let attributes = {
            "gen_ai.prompt.2.content": "function data",
            "gen_ai.prompt.2.role": "function",
            "gen_ai.system": "openai",
        }

        let span = _create_mock_span(attributes)
        let events = lloHandler["extractGenAiPromptEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.openai.message")
        expect((event as any).data["content"]).toEqual("function data")
        expect((event as any).data["role"]).toEqual("function")
        expect(event.attributes!["gen_ai.system"]).toEqual("openai")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.prompt.2.content")
    });
    
    it('testextractGenAiPromptEvents_unknown_role', () => {
        /*
        Test extractGenAiPromptEvents with unknown role
        */
        let attributes = {
            "gen_ai.prompt.3.content": "unknown type content",
            "gen_ai.prompt.3.role": "unknown",
            "gen_ai.system": "bedrock",
        }

        let span = _create_mock_span(attributes)
        let events = lloHandler["extractGenAiPromptEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.bedrock.message")
        expect((event as any).data["content"]).toEqual("unknown type content")
        expect((event as any).data["role"]).toEqual("unknown")
        expect(event.attributes!["gen_ai.system"]).toEqual("bedrock")
    });
    
    it('testextractGenAiCompletionEvents_assistant_role', () => {
        /*
        Test extractGenAiCompletionEvents with assistant role
        */
        let attributes = {
            "gen_ai.completion.0.content": "assistant completion",
            "gen_ai.completion.0.role": "assistant",
            "gen_ai.system": "openai",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]  // end time for completion events

        let events = lloHandler["extractGenAiCompletionEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.assistant.message")
        expect((event as any).data["content"]).toEqual("assistant completion")
        expect((event as any).data["role"]).toEqual("assistant")
        expect(event.attributes!["gen_ai.system"]).toEqual("openai")
        expect(event.timestamp).toEqual([1234567899, 0])
    });
    
    it('testextractGenAiCompletionEvents_other_role', () => {
        /*
        Test extractGenAiCompletionEvents with non-assistant role
        */
        let attributes = {
            "gen_ai.completion.1.content": "other completion",
            "gen_ai.completion.1.role": "other",
            "gen_ai.system": "anthropic",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractGenAiCompletionEvents"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.anthropic.message")
        expect((event as any).data["content"]).toEqual("other completion")
        expect(event.attributes!["gen_ai.system"]).toEqual("anthropic")
    });
    
    it('testextractTraceloopEvents', () => {
        /*
        Test extractTraceloopEvents with standard Traceloop attributes
        */
        let attributes = {
            "traceloop.entity.input": "input data",
            "traceloop.entity.output": "output data",
            "traceloop.entity.name": "my_entity",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractTraceloopEvents"](span, attributes)

        expect(events.length).toEqual(2)

        let input_event = events[0]
        expect(input_event.name).toEqual("gen_ai.my_entity.message")
        expect((input_event.data as any)["content"]).toEqual("input data")
        expect(input_event.attributes!["gen_ai.system"]).toEqual("my_entity")
        expect(input_event.attributes!["original_attribute"]).toEqual("traceloop.entity.input")
        expect(input_event.timestamp).toEqual([1234567890, 0])  // start_time

        let output_event = events[1]
        expect(output_event.name).toEqual("gen_ai.my_entity.message")
        expect((output_event.data as any)["content"]).toEqual("output data")
        expect(output_event.attributes!["gen_ai.system"]).toEqual("my_entity")
        expect(output_event.attributes!["original_attribute"]).toEqual("traceloop.entity.output")
        expect(output_event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_traceloop_all_attributes', () => {
        /*
        Test extractTraceloopEvents with all Traceloop attributes including CrewAI outputs
        */
        let attributes = {
            "traceloop.entity.input": "input data",
            "traceloop.entity.output": "output data",
            "crewai.crew.tasks_output": "[TaskOutput(description='Task 1', output='Result 1')]",
            "crewai.crew.result": "Final crew result",
            "traceloop.entity.name": "crewai_agent",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractTraceloopEvents"](span, attributes)

        expect(events.length).toEqual(4)

        // Get a map of original attributes to events
        // let events_by_attr = {event.attributes["original_attribute"]: event for event in events}
        const events_by_attr: { [key: string]: api.Event } = Object.fromEntries(
            events.map(event => [event.attributes!["original_attribute"], event])
        );
        // for (const event of events) {
        //     events_by_attr[event.attributes["original_attribute"]]
        // }

        // Check all expected attributes are present
        expect(events_by_attr["traceloop.entity.input"]).toBeDefined();
        expect(events_by_attr["traceloop.entity.output"]).toBeDefined();
        expect(events_by_attr["crewai.crew.tasks_output"]).toBeDefined();
        expect(events_by_attr["crewai.crew.result"]).toBeDefined();

        //[]
        // self.assertIn("traceloop.entity.input", events_by_attr)
        // self.assertIn("traceloop.entity.output", events_by_attr)
        // self.assertIn("crewai.crew.tasks_output", events_by_attr)
        // self.assertIn("crewai.crew.result", events_by_attr)

        // Check standard Traceloop events
        let input_event = events_by_attr["traceloop.entity.input"]
        expect(input_event.name).toEqual("gen_ai.crewai_agent.message")
        expect((input_event.data as any)["role"]).toEqual("user")

        let output_event = events_by_attr["traceloop.entity.output"]
        expect(output_event.name).toEqual("gen_ai.crewai_agent.message")
        expect((output_event.data as any)["role"]).toEqual("assistant")

        // Check CrewAI events
        let tasks_event = events_by_attr["crewai.crew.tasks_output"]
        expect(tasks_event.name).toEqual("gen_ai.assistant.message")
        expect((tasks_event.data as any)["role"]).toEqual("assistant")

        let result_event = events_by_attr["crewai.crew.result"]
        expect(result_event.name).toEqual("gen_ai.assistant.message")
        expect((result_event.data as any)["role"]).toEqual("assistant")
    });
    
    it('test_extract_openlit_direct_prompt', () => {
        /*
        Test extractOpenlitSpanEventAttributes with direct prompt attribute
        */
        let attributes = {"gen_ai.prompt": "user direct prompt", "gen_ai.system": "openlit"}

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.user.message")
        expect((event as any).data["content"]).toEqual("user direct prompt")
        expect((event as any).data["role"]).toEqual("user")
        expect(event.attributes!["gen_ai.system"]).toEqual("openlit")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.prompt")
        expect(event.timestamp).toEqual([1234567890, 0])  // start_time
    });
    
    it('test_extract_openlit_direct_completion', () => {
        /*
        Test extractOpenlitSpanEventAttributes with direct completion attribute
        */
        let attributes = {"gen_ai.completion": "assistant direct completion", "gen_ai.system": "openlit"}

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.assistant.message")
        expect((event as any).data["content"]).toEqual("assistant direct completion")
        expect((event as any).data["role"]).toEqual("assistant")
        expect(event.attributes!["gen_ai.system"]).toEqual("openlit")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.completion")
        expect(event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_openlit_all_attributes', () => {
        /*
        Test extractOpenlitSpanEventAttributes with all OpenLit attributes
        */
        let attributes = {
            "gen_ai.prompt": "user prompt",
            "gen_ai.completion": "assistant response",
            "gen_ai.content.revised_prompt": "revised prompt",
            "gen_ai.agent.actual_output": "agent output",
            "gen_ai.agent.human_input": "human input to agent",
            "gen_ai.system": "langchain",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(5)

        // Check that all events have the correct system
        for (const event of events) {
            expect(event.attributes!["gen_ai.system"]).toEqual("langchain")
        }

        // Check we have the expected event types
        const event_types: Set<string> = new Set(
            events.map(event => event.name)
        );

        expect(event_types.has("gen_ai.user.message")).toBeTruthy();
        expect(event_types.has("gen_ai.assistant.message")).toBeTruthy();
        expect(event_types.has("gen_ai.system.message")).toBeTruthy();

        // Verify counts of user messages (should be 2 - prompt and human input)
        // let user_events = [e for e in events if e.name == "gen_ai.user.message"]
        let user_events = events.filter((event) => event.name == "gen_ai.user.message")
        expect(user_events.length).toEqual(2)

        // Check original attributes
        let original_attrs = new Set() //[]{event.attributes["original_attribute"] for event in events}
        events.forEach((event) => {
            if (event.attributes)
                original_attrs.add(event.attributes["original_attribute"])
        })
        
        expect(original_attrs.has("gen_ai.prompt")).toBeTruthy();
        expect(original_attrs.has("gen_ai.completion")).toBeTruthy();
        expect(original_attrs.has("gen_ai.content.revised_prompt")).toBeTruthy();
        expect(original_attrs.has("gen_ai.agent.actual_output")).toBeTruthy();
        expect(original_attrs.has("gen_ai.agent.human_input")).toBeTruthy();
    });
    
    it('test_extract_openlit_revised_prompt', () => {
        /*
        Test extractOpenlitSpanEventAttributes with revised prompt attribute
        */
        let attributes = {"gen_ai.content.revised_prompt": "revised system prompt", "gen_ai.system": "openlit"}

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.system.message")
        expect((event as any).data["content"]).toEqual("revised system prompt")
        expect((event as any).data["role"]).toEqual("system")
        expect(event.attributes!["gen_ai.system"]).toEqual("openlit")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.content.revised_prompt")
        expect(event.timestamp).toEqual([1234567890, 0])  // start_time
    });
    
    it('test_extract_openinference_direct_attributes', () => {
        /*
        Test["extractOpeninferenceAttributes"] with direct input/output values
        */
        let attributes = {
            "input.value": "user prompt",
            "output.value": "assistant response",
            "llm.model_name": "gpt-4",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpeninferenceAttributes"](span, attributes)

        expect(events.length).toEqual(2)

        let input_event = events[0]
        expect(input_event.name).toEqual("gen_ai.user.message")
        expect((input_event.data as any)["content"]).toEqual("user prompt")
        expect((input_event.data as any)["role"]).toEqual("user")
        expect(input_event.attributes!["gen_ai.system"]).toEqual("gpt-4")
        expect(input_event.attributes!["original_attribute"]).toEqual("input.value")
        expect(input_event.timestamp).toEqual([1234567890, 0])  // start_time

        let output_event = events[1]
        expect(output_event.name).toEqual("gen_ai.assistant.message")
        expect((output_event.data as any)["content"]).toEqual("assistant response")
        expect((output_event.data as any)["role"]).toEqual("assistant")
        expect(output_event.attributes!["gen_ai.system"]).toEqual("gpt-4")
        expect(output_event.attributes!["original_attribute"]).toEqual("output.value")
        expect(output_event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_openinference_structured_input_messages', () => {
        /*
        Test["extractOpeninferenceAttributes"] with structured input messages
        */
        let attributes = {
            "llm.input_messages.0.message.content": "system prompt",
            "llm.input_messages.0.message.role": "system",
            "llm.input_messages.1.message.content": "user message",
            "llm.input_messages.1.message.role": "user",
            "llm.model_name": "claude-3",
        }

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractOpeninferenceAttributes"](span, attributes)

        expect(events.length).toEqual(2)

        let system_event = events[0]
        expect(system_event.name).toEqual("gen_ai.system.message")
        expect((system_event.data as any)["content"]).toEqual("system prompt")
        expect((system_event.data as any)["role"]).toEqual("system")
        expect(system_event.attributes!["gen_ai.system"]).toEqual("claude-3")
        expect(system_event.attributes!["original_attribute"]).toEqual("llm.input_messages.0.message.content")

        let user_event = events[1]
        expect(user_event.name).toEqual("gen_ai.user.message")
        expect((user_event.data as any)["content"]).toEqual("user message")
        expect((user_event.data as any)["role"]).toEqual("user")
        expect(user_event.attributes!["gen_ai.system"]).toEqual("claude-3")
        expect(user_event.attributes!["original_attribute"]).toEqual("llm.input_messages.1.message.content")
    });
    
    it('test_extract_openinference_structured_output_messages', () => {
        /*
        Test["extractOpeninferenceAttributes"] with structured output messages
        */
        let attributes = {
            "llm.output_messages.0.message.content": "assistant response",
            "llm.output_messages.0.message.role": "assistant",
            "llm.model_name": "llama-3",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpeninferenceAttributes"](span, attributes)

        expect(events.length).toEqual(1)

        let output_event = events[0]
        expect(output_event.name).toEqual("gen_ai.assistant.message")
        expect((output_event.data as any)["content"]).toEqual("assistant response")
        expect((output_event.data as any)["role"]).toEqual("assistant")
        expect(output_event.attributes!["gen_ai.system"]).toEqual("llama-3")
        expect(output_event.attributes!["original_attribute"]).toEqual("llm.output_messages.0.message.content")
        expect(output_event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_openinference_mixed_attributes', () => {
        /*
        Test["extractOpeninferenceAttributes"] with a mix of all attribute types
        */
        let attributes = {
            "input.value": "direct input",
            "output.value": "direct output",
            "llm.input_messages.0.message.content": "message input",
            "llm.input_messages.0.message.role": "user",
            "llm.output_messages.0.message.content": "message output",
            "llm.output_messages.0.message.role": "assistant",
            "llm.model_name": "bedrock.claude-3",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpeninferenceAttributes"](span, attributes)

        expect(events.length).toEqual(4)

        // Verify all events have the correct model name
        for (const event of events) {
            expect(event.attributes!["gen_ai.system"]).toEqual("bedrock.claude-3")
        }

        // We don't need to check every detail since other tests do that,
        // but we can verify we got all the expected event types
        //[] let event_types = {event.name for event in events}
        let event_types = new Set(events.map((event) => event.name))

        expect(event_types.has("gen_ai.user.message")).toBeTruthy();
        expect(event_types.has("gen_ai.assistant.message")).toBeTruthy();

        // Verify original attributes were correctly captured
        let original_attrs = new Set() //[]{event.attributes["original_attribute"] for event in events}
        events.forEach((event) => {
            if (event.attributes)
                original_attrs.add(event.attributes["original_attribute"])
        })
        expect(original_attrs.has("input.value")).toBeTruthy();
        expect(original_attrs.has("output.value")).toBeTruthy();
        expect(original_attrs.has("llm.input_messages.0.message.content")).toBeTruthy();
        expect(original_attrs.has("llm.output_messages.0.message.content")).toBeTruthy();
    });
    
    it('test_extract_openlit_agent_actual_output', () => {
        /*
        Test extractOpenlitSpanEventAttributes with agent actual output attribute
        */
        let attributes = {"gen_ai.agent.actual_output": "Agent task output result", "gen_ai.system": "crewai"}

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(1)

        let event = events[0]
        expect(event.name).toEqual("gen_ai.assistant.message")
        expect((event as any).data["content"]).toEqual("Agent task output result")
        expect((event as any).data["role"]).toEqual("assistant")
        expect(event.attributes!["gen_ai.system"]).toEqual("crewai")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.agent.actual_output")
        expect(event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_openlit_agent_human_input', () => {
        /*
        Test extractOpenlitSpanEventAttributes with agent human input attribute
        */
        let attributes = {"gen_ai.agent.human_input": "Human input to the agent", "gen_ai.system": "crewai"}

        let span = _create_mock_span(attributes)

        let events = lloHandler["extractOpenlitSpanEventAttributes"](span, attributes)

        expect(events.length).toEqual(1)
        let event = events[0]
        expect(event.name).toEqual("gen_ai.user.message")
        expect((event as any).data["content"]).toEqual("Human input to the agent")
        expect((event as any).data["role"]).toEqual("user")
        expect(event.attributes!["gen_ai.system"]).toEqual("crewai")
        expect(event.attributes!["original_attribute"]).toEqual("gen_ai.agent.human_input")
        expect(event.timestamp).toEqual([1234567890, 0])  // start_time
    });
    
    it('test_extract_traceloop_crew_outputs', () => {
        /*
        Test extractTraceloopEvents with CrewAI specific attributes
        */
        let attributes = {
            "crewai.crew.tasks_output": "[TaskOutput(description='Task description', output='Task result')]",
            "crewai.crew.result": "Final crew execution result",
            "traceloop.entity.name": "crewai",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractTraceloopEvents"](span, attributes)

        expect(events.length).toEqual(2)

        // Get a map of original attributes to their content
        //[] let events_by_attr = {event.attributes["original_attribute"]: event for event in events}
        const events_by_attr: { [key: string]: api.Event } = Object.fromEntries(
            events.map(event => [event.attributes!["original_attribute"], event])
        );

        // Check the tasks output event
        expect(events_by_attr["crewai.crew.tasks_output"]).toBeDefined();
        let tasks_event = events_by_attr["crewai.crew.tasks_output"]
        expect(tasks_event.name).toEqual("gen_ai.assistant.message")
        expect((tasks_event.data as any)["content"])
            .toEqual("[TaskOutput(description='Task description', output='Task result')]")
        expect((tasks_event.data as any)["role"]).toEqual("assistant")
        expect(tasks_event.attributes!["gen_ai.system"]).toEqual("crewai")
        expect(tasks_event.timestamp).toEqual([1234567899, 0])  // endTime

        // Check the result event
        expect(events_by_attr["crewai.crew.result"]).toBeDefined();
        let result_event = events_by_attr["crewai.crew.result"]
        expect(result_event.name).toEqual("gen_ai.assistant.message")
        expect((result_event.data as any)["content"]).toEqual("Final crew execution result")
        expect((result_event.data as any)["role"]).toEqual("assistant")
        expect(result_event.attributes!["gen_ai.system"]).toEqual("crewai")
        expect(result_event.timestamp).toEqual([1234567899, 0])  // endTime
    });
    
    it('test_extract_traceloop_crew_outputs_with_gen_ai_system', () => {
        /*
        Test extractTraceloopEvents with CrewAI specific attributes when gen_ai.system is available
        */
        let attributes = {
            "crewai.crew.tasks_output": "[TaskOutput(description='Task description', output='Task result')]",
            "crewai.crew.result": "Final crew execution result",
            "traceloop.entity.name": "oldvalue",
            "gen_ai.system": "crewai-agent",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractTraceloopEvents"](span, attributes)

        expect(events.length).toEqual(2)

        // Get a map of original attributes to their content
        //[] let events_by_attr = {event.attributes["original_attribute"]: event for event in events}
        const events_by_attr: { [key: string]: api.Event } = Object.fromEntries(
            events.map(event => [event.attributes!["original_attribute"], event])
        );

        // Check the tasks output event
        expect(events_by_attr["crewai.crew.tasks_output"]).toBeDefined();
        let tasks_event = events_by_attr["crewai.crew.tasks_output"]
        expect(tasks_event.name).toEqual("gen_ai.assistant.message")
        // Should use gen_ai.system attribute instead of traceloop.entity.name
        expect(tasks_event.attributes!["gen_ai.system"]).toEqual("crewai-agent")

        // Check the result event
        expect(events_by_attr["crewai.crew.result"]).toBeDefined();
        let result_event = events_by_attr["crewai.crew.result"]
        expect(result_event.name).toEqual("gen_ai.assistant.message")
        // Should use gen_ai.system attribute instead of traceloop.entity.name
        expect(result_event.attributes!["gen_ai.system"]).toEqual("crewai-agent")
    });
    
    it('test_extract_traceloop_entity_with_gen_ai_system', () => {
        /*
        Test that traceloop.entity.input and traceloop.entity.output still use traceloop.entity.name
        even when gen_ai.system is available
        */
        let attributes = {
            "traceloop.entity.input": "input data",
            "traceloop.entity.output": "output data",
            "traceloop.entity.name": "my_entity",
            "gen_ai.system": "should-not-be-used",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        let events = lloHandler["extractTraceloopEvents"](span, attributes)

        expect(events.length).toEqual(2)

        // Get a map of original attributes to their content
        //[] let events_by_attr = {event.attributes["original_attribute"]: event for event in events}
        const events_by_attr: { [key: string]: api.Event } = Object.fromEntries(
            events.map(event => [event.attributes!["original_attribute"], event])
        );

        // Regular traceloop entity attributes should still use traceloop.entity.name
        let input_event = events_by_attr["traceloop.entity.input"]
        expect(input_event.name).toEqual("gen_ai.my_entity.message")
        expect(input_event.attributes!["gen_ai.system"]).toEqual("my_entity")

        let output_event = events_by_attr["traceloop.entity.output"]
        expect(output_event.name).toEqual("gen_ai.my_entity.message")
        expect(output_event.attributes!["gen_ai.system"]).toEqual("my_entity")
    });
    
    it('test_emit_llo_attributes', () => {
        /*
        Test _emit_llo_attributes
        */
        let attributes = {
            "gen_ai.prompt.0.content": "prompt content",
            "gen_ai.prompt.0.role": "user",
            "gen_ai.completion.0.content": "completion content",
            "gen_ai.completion.0.role": "assistant",
            "traceloop.entity.input": "traceloop input",
            "traceloop.entity.name": "entity_name",
            "gen_ai.system": "openai",
            "gen_ai.agent.actual_output": "agent output",
            "crewai.crew.tasks_output": "tasks output",
            "crewai.crew.result": "crew result",
        }

        let span = _create_mock_span(attributes)
        span.endTime = [1234567899, 0]

        // with patch.object(lloHandler, "extractGenAiPromptEvents") as mock_extract_prompt, patch.object(
        //     lloHandler, "extractGenAiCompletionEvents"
        // ) as mock_extract_completion, patch.object(
        //     lloHandler, "extractTraceloopEvents"
        // ) as mock_extract_traceloop, patch.object(
        //     lloHandler, "extractOpenlitSpanEventAttributes"
        // ) as mock_extract_openlit, patch.object(
        //     lloHandler, ["extractOpeninferenceAttributes"]"
        // ) as mock_extract_openinference:

            // Create mocks with name attribute properly set
            let prompt_event: api.Event = {
              name: "gen_ai.user.message"
            }
            let completion_event: api.Event = {
                name: "gen_ai.assistant.message"
            }
            let traceloop_event: api.Event = {name: "gen_ai.entity.message"}
            let openlit_event: api.Event = {name: "gen_ai.langchain.message"}
            let openinference_event: api.Event = {name: "gen_ai.anthropic.message"}

            const lloHandlerExtractGenAiPromptEvents = sinon.stub(lloHandler, <any>'extractGenAiPromptEvents').callsFake((span, attributes, eventTimestamp) => [prompt_event]);
            const lloHandlerExtractGenAiCompletionEvents = sinon.stub(lloHandler, <any>'extractGenAiCompletionEvents').callsFake((span, attributes, eventTimestamp) => [completion_event]);
            const lloHandlerExtractTraceloopEvents = sinon.stub(lloHandler, <any>'extractTraceloopEvents').callsFake((span, attributes, eventTimestamp) => [traceloop_event]);
            const lloHandlerExtractOpenlitSpanEventAttributes = sinon.stub(lloHandler, <any>'extractOpenlitSpanEventAttributes').callsFake((span, attributes, eventTimestamp) => [openlit_event]);
            const lloHandlerExtractOpeninferenceAttributes = sinon.stub(lloHandler, <any>'extractOpeninferenceAttributes').callsFake((span, attributes, eventTimestamp) => [openinference_event]);

            const event_logger_mockEmit = sinon.stub(event_logger_mock, 'emit').callsFake((event: api.Event) => {});

            // mock_extract_prompt.return_value = [prompt_event]
            // mock_extract_completion.return_value = [completion_event]
            // mock_extract_traceloop.return_value = [traceloop_event]
            // mock_extract_openlit.return_value = [openlit_event]
            // mock_extract_openinference.return_value = [openinference_event]

            lloHandler["emitLloAttributes"](span, attributes)
            
            const promptSpan: ReadableSpan = lloHandlerExtractGenAiPromptEvents.getCall(0).args[0];
            const promptAttributes: Attributes = lloHandlerExtractGenAiPromptEvents.getCall(0).args[1];
            const promptEventTimestamp: Attributes = lloHandlerExtractGenAiPromptEvents.getCall(0).args[2];
            expect(promptSpan).toBe(span);
            expect(promptAttributes).toBe(attributes);
            expect(promptEventTimestamp).toBeUndefined();

            const completionSpan: ReadableSpan = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[0];
            const completionAttributes: Attributes = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[1];
            const completionEventTimestamp: Attributes = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[2];
            expect(completionSpan).toBe(span);
            expect(completionAttributes).toBe(attributes);
            expect(completionEventTimestamp).toBeUndefined();

            const traceloopSpan: ReadableSpan = lloHandlerExtractTraceloopEvents.getCall(0).args[0];
            const traceloopAttributes: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[1];
            const traceloopEventTimestamp: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[2];
            expect(traceloopSpan).toBe(span);
            expect(traceloopAttributes).toBe(attributes);
            expect(traceloopEventTimestamp).toBeUndefined();

            const openlitSpan: ReadableSpan = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[0];
            const openlitAttributes: Attributes = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[1];
            const openlitEventTimestamp: Attributes = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[2];
            expect(openlitSpan).toBe(span);
            expect(openlitAttributes).toBe(attributes);
            expect(openlitEventTimestamp).toBeUndefined();

            const openinferenceSpan: ReadableSpan = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[0];
            const openinferenceAttributes: Attributes = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[1];
            const openinferenceEventTimestamp: Attributes = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[2];
            expect(openinferenceSpan).toBe(span);
            expect(openinferenceAttributes).toBe(attributes);
            expect(openinferenceEventTimestamp).toBeUndefined();

            // mock_extract_prompt.assert_called_once_with(span, attributes, None)
            // mock_extract_completion.assert_called_once_with(span, attributes, None)
            // mock_extract_traceloop.assert_called_once_with(span, attributes, None)
            // mock_extract_openlit.assert_called_once_with(span, attributes, None)
            // mock_extract_openinference.assert_called_once_with(span, attributes, None)

            const eventLoggerPromptCallArg = event_logger_mockEmit.getCall(0).args[0]
            const eventLoggerCompletionCallArg = event_logger_mockEmit.getCall(1).args[0]
            const eventLoggerTraceloopCallArg = event_logger_mockEmit.getCall(2).args[0]
            const eventLoggerOpenlitCallArg = event_logger_mockEmit.getCall(3).args[0]
            const eventLoggerOpeninferenceCallArg = event_logger_mockEmit.getCall(4).args[0]

            expect(eventLoggerPromptCallArg).toBe(prompt_event);
            expect(eventLoggerCompletionCallArg).toBe(completion_event);
            expect(eventLoggerTraceloopCallArg).toBe(traceloop_event);
            expect(eventLoggerOpenlitCallArg).toBe(openlit_event);
            expect(eventLoggerOpeninferenceCallArg).toBe(openinference_event);

            //[] self.event_logger_mock.emit.assert_has_calls(
            //     [
            //         call(prompt_event),
            //         call(completion_event),
            //         call(traceloop_event),
            //         call(openlit_event),
            //         call(openinference_event),
            //     ]
            // )
        });
        
    it('test_process_spans', () => {
        /*
        Test process_spans
        */
        let attributes: Attributes = {"gen_ai.prompt.0.content": "prompt content", "normal.attribute": "normal value"}

        let span = _create_mock_span(attributes)

        // with patch.object(lloHandler, "_emit_llo_attributes") as mock_emit, patch.object(
        //     lloHandler, "_filter_attributes"
        // ) as mock_filter:

            let filtered_attributes: Attributes = {"normal.attribute": "normal value"}
        
            const lloHandlerEmitLloAttributes = sinon.stub(lloHandler, <any>'emitLloAttributes');
            const lloHandlerFilterAttributes = sinon.stub(lloHandler, <any>'filterAttributes').callsFake((attributes) => filtered_attributes);
    

            // mock_filter.return_value = filtered_attributes

            let result = lloHandler.processSpans([span])

            const emitLloAttributesCallArg0 = lloHandlerEmitLloAttributes.getCall(0).args[0]
            const emitLloAttributesCallArg1 = lloHandlerEmitLloAttributes.getCall(0).args[1]
            const emitLloAttributesCallArg2 = lloHandlerEmitLloAttributes.getCall(0).args[2]
            expect(emitLloAttributesCallArg0).toBe(span);
            expect(emitLloAttributesCallArg1).toBe(attributes);
            expect(emitLloAttributesCallArg2).toBe(undefined);

            // mock_emit.assert_called_once_with(span, attributes)

            const filterAttributesCallArg0 = lloHandlerFilterAttributes.getCall(0).args[0]
            expect(filterAttributesCallArg0).toBe(attributes);

            // mock_filter.assert_called_once_with(attributes)

            expect(result.length).toEqual(1)
            expect(result[0]).toEqual(span)
            // Access the _attributes property that was set by the process_spans method
            expect(result[0].attributes).toEqual(filtered_attributes)
    });
});