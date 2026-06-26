// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves `aws.local.environment` from OTel Resource attributes using the same
 * precedence as the CloudWatch agent's awsentity processor:
 *
 *   1. Explicit deployment.environment[.name] → use as-is
 *   2. EKS / K8s → "eks:<cluster>/<namespace>" or "k8s:<cluster>/<namespace>"
 *   3. ECS → "ecs:<cluster>"
 *   4. EC2 (host is actually EC2) → "ec2:<asg>" when an ASG is known, else "ec2:default"
 *   5. Otherwise (non-AWS / undetected host) → "" (omit the key)
 *
 * The EC2 branch is gated on the host actually being EC2, mirroring the CloudWatch agent,
 * whose environment branches only run for EC2 (Platform == ModeEC2) or Kubernetes. On a
 * non-AWS / non-K8s host the agent leaves the Environment empty, so the SDK returns ""
 * rather than falsely claiming "ec2:default".
 *
 * This enables the SDK to compute the same environment value the agent would, without
 * depending on the agent process — an SDK-only alternative for deployment scenarios
 * where the CloudWatch agent is not available or doesn't run the environment resolver.
 */

const AWS_LOCAL_ENVIRONMENT_KEY = 'aws.local.environment';

export interface EnvironmentResolverInput {
  /** All resource attributes as a flat key→value record (from Resource.attributes). */
  attributes: Record<string, unknown>;
}

/**
 * Resolve `aws.local.environment` from the given resource attributes.
 * Returns the resolved value, or undefined if insufficient inputs are available.
 */
export function resolveLocalEnvironment(input: EnvironmentResolverInput): string {
  const attrs = input.attributes;

  // 1. Explicit deployment.environment[.name] wins outright.
  const explicitEnv = asString(attrs['deployment.environment.name']) || asString(attrs['deployment.environment']);
  if (explicitEnv) {
    return explicitEnv;
  }

  // 2. Kubernetes (EKS / K8s): compose from platform + cluster + namespace.
  const k8sClusterName = asString(attrs['k8s.cluster.name']);
  const namespace = asString(attrs['k8s.namespace.name']);
  const cloudPlatform = asString(attrs['cloud.platform']);

  if (k8sClusterName) {
    const ns = namespace || 'UnknownNamespace';
    // cloud.platform = "aws_eks" → eks prefix; otherwise generic k8s.
    const prefix = cloudPlatform === 'aws_eks' ? 'eks' : 'k8s';
    return `${prefix}:${k8sClusterName}/${ns}`;
  }

  // 3. ECS: ecs:<clusterName>. The cluster name is the last segment of the ECS
  //    cluster ARN (aws.ecs.cluster.arn), which the OTel awsEcsDetector emits.
  //    Matches the agent's ecs.go resolver precedence (cluster → ecs:<cluster>).
  const ecsClusterArn = asString(attrs['aws.ecs.cluster.arn']);
  if (ecsClusterArn) {
    const ecsCluster = ecsClusterArn.split('/').pop() || '';
    if (ecsCluster) {
      return `ecs:${ecsCluster}`;
    }
  }

  // 4. EC2: only when the host is actually EC2 (matches the agent's Platform == ModeEC2
  //    gate). Signals: cloud.platform=aws_ec2, host.id (EC2 instance id from the OTel EC2
  //    detector), or the ASG tag (an IMDS-only EC2 signal).
  const asg = asString(attrs['ec2.tag.aws:autoscaling:groupName']);
  const isEc2 = cloudPlatform === 'aws_ec2' || !!asString(attrs['host.id']) || !!asg;
  if (isEc2) {
    return asg ? `ec2:${asg}` : 'ec2:default';
  }

  // 5. Non-AWS / undetected host: the agent leaves Environment empty here, so do we.
  return '';
}

/**
 * Stamps `aws.local.environment` onto a mutable resource-attributes record, using
 * the same resolution as the agent. Idempotent: if the attribute is already set
 * (e.g. from a prior agent pass-through), it is left unchanged.
 */
export function stampLocalEnvironment(attrs: Record<string, string>): void {
  if (attrs[AWS_LOCAL_ENVIRONMENT_KEY]) {
    return;
  }
  // Only stamp when a value resolved; a non-AWS host omits the key entirely (matching the
  // CloudWatch agent, which leaves Environment empty there).
  const resolved = resolveLocalEnvironment({ attributes: attrs });
  if (resolved) {
    attrs[AWS_LOCAL_ENVIRONMENT_KEY] = resolved;
  }
}

function asString(v: unknown): string {
  if (typeof v === 'string' && v !== '') return v;
  return '';
}
