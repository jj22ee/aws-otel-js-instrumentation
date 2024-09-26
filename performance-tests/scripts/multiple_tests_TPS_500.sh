#!/bin/bash

set -ex 

max=10

hostType=$(ec2-metadata --instance-type | cut -d " " -f 2)
echo $hostType

for i in `seq 1 $max`
do
        echo "500-$i"
        CONCURRENCY=5 DURATION=900 TPS=500 ./gradlew -i clean test > test_run_logs-500-$i.out
        mv test_run_logs-500-$i.out results/
        mv results results-out-500-$i
        aws s3 cp results-out-500-$i s3://adot-js-testing/perf-result/$hostType/500-$i --recursive
done

for i in `seq 1 $max`
do
        echo "100-$i"
        CONCURRENCY=5 DURATION=900 TPS=100 ./gradlew -i clean test > test_run_logs-100-$i.out
        mv test_run_logs-100-$i.out results/
        mv results results-out-100-$i
        aws s3 cp results-out-100-$i s3://adot-js-testing/perf-result/$hostType/100-$i --recursive
done