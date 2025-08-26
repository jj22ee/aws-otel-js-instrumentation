import { diag } from '@opentelemetry/api';
import * as opentelemetry from '@opentelemetry/sdk-node';

export type ConfigurationOverride = (configuration: Partial<opentelemetry.NodeSDKConfiguration>) => void;

export const isAwsSynthethicsEnvironment = (): boolean => {
  return process.env.AWS_SYNTHETICS_CONFIGURATION_OVERRIDE != null;
}

export const conditionallyApplySyntheticsConfig = (configuration: Partial<opentelemetry.NodeSDKConfiguration>) => {
  if (isAwsSynthethicsEnvironment()) {
    let configurationOverride = (config: Partial<opentelemetry.NodeSDKConfiguration>) => {};

    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (typeof __non_webpack_require__ === 'function') {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        configurationOverride = __non_webpack_require__(
          process.env.AWS_SYNTHETICS_CONFIGURATION_OVERRIDE!
        ).configurationOverride;
      } else {
        configurationOverride = require(process.env.AWS_SYNTHETICS_CONFIGURATION_OVERRIDE!).configurationOverride;
      }

      if (typeof configurationOverride === 'function') {
        configurationOverride(configuration);
      }
    } catch (e: unknown) {
      diag.error('Error applying configuration override', e);
    }
  }
}

