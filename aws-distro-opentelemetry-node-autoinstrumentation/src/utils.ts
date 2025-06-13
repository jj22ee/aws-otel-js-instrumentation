// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

const AGENT_OBSERVABILITY_ENABLED = 'AGENT_OBSERVABILITY_ENABLED';

// Bypass `readonly` restriction of a Type.
// Workaround provided from official TypeScript docs:
// https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-8.html#improved-control-over-mapped-type-modifiers
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export const getNodeVersion = () => {
  const nodeVersion = process.versions.node;
  const versionParts = nodeVersion.split('.');

  if (versionParts.length === 0) {
    return -1;
  }

  const majorVersion = parseInt(versionParts[0], 10);

  if (isNaN(majorVersion)) {
    return -1;
  }

  return majorVersion;
};

export const isAgentObservabilityEnabled = () => {
  const agentObservabilityEnabled: string | undefined = process.env[AGENT_OBSERVABILITY_ENABLED];
  if (agentObservabilityEnabled === undefined) {
    return false;
  }

  return agentObservabilityEnabled.toLowerCase() === 'true';
};

/**
 * Get AWS region from environment or boto3 session.
 * Returns the AWS region in the following priority order:
 * 1. AWS_REGION environment variable
 * 2. AWS_DEFAULT_REGION environment variable
 * 3. boto3 session's region (if boto3 is available)
 * 4. None if no region can be determined
 */
export const getAwsRegion = (): string | undefined => {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region) {
    return region;
  }

  //[][] try {
  //   const currentRegion = await loadConfig(NODE_REGION_CONFIG_OPTIONS, NODE_REGION_CONFIG_FILE_OPTIONS)();
  //   return currentRegion
  // } catch (e: unknown) {}

  diag.warn(
    'AWS region not found in environment variables (AWS_REGION, AWS_DEFAULT_REGION) and not detected via AWS SDK. Please set AWS_REGION environment variable explicitly.'
  );

  return undefined;
};
