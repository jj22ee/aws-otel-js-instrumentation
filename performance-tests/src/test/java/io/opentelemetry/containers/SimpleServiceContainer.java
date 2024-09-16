/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 * Modifications Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

package io.opentelemetry.containers;

import com.github.dockerjava.api.model.Capability;
import io.opentelemetry.distros.DistroConfig;
import io.opentelemetry.util.NamingConventions;
import io.opentelemetry.util.RuntimeUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.output.Slf4jLogConsumer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.lifecycle.Startable;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

public class SimpleServiceContainer {

  private static final Logger logger =
      LoggerFactory.getLogger(SimpleServiceContainer.class);

  private final Network network;
  private final Startable collector;
  private final DistroConfig distroConfig;
  private final NamingConventions namingConventions;
  private final int port;
  private final boolean isApplication;

  public SimpleServiceContainer(
      Network network,
      Startable collector,
      DistroConfig distroConfig,
      NamingConventions namingConventions,
      int port,
      boolean isApplication) {
    this.network = network;
    this.collector = collector;
    this.distroConfig = distroConfig;
    this.namingConventions = namingConventions;
    this.port = port;
    this.isApplication = isApplication;
  }

  public GenericContainer<?> build() {
    String cores = isApplication ? RuntimeUtil.getApplicationCores() : RuntimeUtil.getNonApplicationCores();
    GenericContainer<?> container =
        new GenericContainer<>(DockerImageName.parse(distroConfig.getImageName()))
            .withNetwork(network)
            .withNetworkAliases("simple-service", "backend")
            .withLogConsumer(new Slf4jLogConsumer(logger))
            .withExposedPorts(port)
            .waitingFor(Wait.forHttp("/health-check").forPort(port))
            .withFileSystemBind(
                namingConventions.localResults(), namingConventions.containerResults())
            .withCopyFileToContainer(
                MountableFile.forClasspathResource("run.sh"), "app/run.sh")
            .withCopyFileToContainer(
                MountableFile.forClasspathResource("profiler.py"), "app/profiler.py")
            .withCopyFileToContainer(
                MountableFile.forClasspathResource("executeProfiler.sh"), "app/executeProfiler.sh")
            .withEnv(distroConfig.getAdditionalEnvVars())
            .withEnv("TEST_NAME", distroConfig.getName())
            .withEnv("PROFILE", System.getenv("PROFILE"))
            .withEnv("DURATION", System.getenv("DURATION"))
            .withEnv("LISTEN_ADDRESS", "0.0.0.0:" + port)
            .dependsOn(collector)
            .withCreateContainerCmdModifier(
                cmd -> cmd.getHostConfig()
                    .withCpusetCpus(cores)
                    .withCapAdd(Capability.SYS_PTRACE))
            .withCommand("bash run.sh");

    if (distroConfig.doInstrument()) {
      container
          .withEnv("DO_INSTRUMENT", "true")
          .withEnv("OTEL_TRACES_EXPORTER", "otlp")
          .withEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
          .withEnv("OTEL_METRICS_EXPORTER", "none")
          .withEnv("OTEL_METRIC_EXPORT_INTERVAL", "60000")
          .withEnv("OTEL_EXPORTER_OTLP_INSECURE", "true")
          .withEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
          .withEnv("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "flask")
          .withEnv("OTEL_RESOURCE_ATTRIBUTES", "service.name=flask_server");
    }
    return container;
  }
}