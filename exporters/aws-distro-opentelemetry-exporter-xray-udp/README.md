# AWS Distro for OpenTelemetry (ADOT) OTLP UDP Exporter

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-distro-opentelemetry-exporter-xray-udp
```

## Usage

```js
import { AwsXrayUdpSpanExporter } from './aws-xray-udp-span-exporter';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';

// ...

let AwsXrayUdpSpanExporter: SpanExporter = new AwsXrayUdpSpanExporter('127.0.0.1:2000');
```
