# AWS Distro for OpenTelemetry (ADOT) OTLP UDP Exporter

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-distro-opentelemetry-exporter-xray-udp
```

## Usage

```ts
import { AwsXrayUdpSpanExporter } from "@aws/aws-distro-opentelemetry-exporter-xray-udp"
import { SpanExporter } from '@opentelemetry/sdk-trace-base';

// ...

let AwsXrayUdpSpanExporter: SpanExporter = new AwsXrayUdpSpanExporter('127.0.0.1:2000');
```
