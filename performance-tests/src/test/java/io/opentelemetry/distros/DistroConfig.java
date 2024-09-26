/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 * Modifications Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

package io.opentelemetry.distros;

import java.util.Collections;
import java.util.Map;

public enum DistroConfig {
  NONE(
      "no distro at all",
      false,
      Collections.EMPTY_MAP,
      "performance-test/simple-service-adot"),
  OTEL_100(
      "OTEL distro with 100% sampling",
      true,
      Map.of(
        "OTEL_TRACES_SAMPLER",
        "traceidratio",
        "OTEL_TRACES_SAMPLER_ARG",
        "1"
      ),
      "performance-test/simple-service-otel"),
  ADOT_100(
      "ADOT distro with Application Signals disabled, 100% sampling",
      true,
      Map.of(
          "ADOT",
          "true",
          "AWS_REGION",
          "us-west-2",
          "OTEL_TRACES_SAMPLER",
          "xray",
          "OTEL_TRACES_SAMPLER_ARG",
          "endpoint=http://collector:2000",
          "OTEL_RESOURCE_ATTRIBUTES",
          "service.name=100_percent"
      ),
      "performance-test/simple-service-adot"),
  AS_100(
      "ADOT distro with Application Signals enabled, 100% sampling",
      true,
      Map.of(
          "ADOT",
          "true",
          "AWS_REGION",
          "us-west-2",
          "OTEL_TRACES_SAMPLER",
          "xray",
          "OTEL_TRACES_SAMPLER_ARG",
          "endpoint=http://collector:2000",
          "OTEL_RESOURCE_ATTRIBUTES",
          "service.name=100_percent",
          "OTEL_AWS_APPLICATION_SIGNALS_ENABLED",
          "true",
          "OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT",
          "http://collector:4318/v1/metrics"
      ),
      "performance-test/simple-service-adot"),
  OTEL_005(
      "OTEL distro with 5% sampling",
      true,
      Map.of(
        "OTEL_TRACES_SAMPLER",
        "traceidratio",
        "OTEL_TRACES_SAMPLER_ARG",
        "0.05"
      ),
      "performance-test/simple-service-otel"),
  ADOT_005(
      "ADOT distro with Application Signals disabled, 5% sampling",
      true,
      Map.of(
          "ADOT",
          "true",
          "AWS_REGION",
          "us-west-2",
          "OTEL_TRACES_SAMPLER",
          "xray",
          "OTEL_TRACES_SAMPLER_ARG",
          "endpoint=http://collector:2000",
          "OTEL_RESOURCE_ATTRIBUTES",
          "service.name=5_percent"
      ),
      "performance-test/simple-service-adot"),
  AS_005(
      "ADOT distro with Application Signals enabled, 5% sampling",
      true,
      Map.of(
          "ADOT",
          "true",
          "AWS_REGION",
          "us-west-2",
          "OTEL_TRACES_SAMPLER",
          "xray",
          "OTEL_TRACES_SAMPLER_ARG",
          "endpoint=http://collector:2000",
          "OTEL_RESOURCE_ATTRIBUTES",
          "service.name=5_percent",
          "OTEL_AWS_APPLICATION_SIGNALS_ENABLED",
          "true",
          "OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT",
          "http://collector:4318/v1/metrics"
      ),
      "performance-test/simple-service-adot");

  private final String description;
  private final boolean doInstrument;
  private final Map<String, String> additionalEnvVars;
  private final String imageName;

  DistroConfig(
      String description,
      boolean doInstrument,
      Map<String, String> additionalEnvVars,
      String imageName) {
    this.description = description;
    this.doInstrument = doInstrument;
    this.additionalEnvVars = additionalEnvVars;
    this.imageName = imageName;
  }

  public String getName() {
    return this.name();
  }

  public String getDescription() {
    return description;
  }

  public boolean doInstrument() {
    return doInstrument;
  }

  public Map<String, String> getAdditionalEnvVars() {
    return Collections.unmodifiableMap(additionalEnvVars);
  }

  public String getImageName() {
    return imageName;
  }
}
