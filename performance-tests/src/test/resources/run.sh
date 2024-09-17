#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Fail fast
set -ex

# If a distro is not provided, run service normally. If it is, run the service with instrumentation.
if [[ "${DO_INSTRUMENT}" == "true" ]]; then
    if [[ "${ADOT}" == "true" ]]; then
        node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' sample-app-express-server &
    else
        node --require '@opentelemetry/auto-instrumentations-node/register' sample-app-express-server &
    fi
else
    node sample-app-express-server &
fi

# if [[ "${PROFILE}" == "true" ]]; then
#     PID=$!
#     sleep 3
#     py-spy record -d $DURATION -r 33 -o /results/profile-$TEST_NAME.svg --pid $PID
# fi

wait