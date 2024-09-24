#!/bin/bash

set -ex 

max=10

hostType=$(ec2-metadata --instance-type | cut -d " " -f 2)
echo $hostType

for i in `seq 1 $max`
do
        echo "$i"
        CONCURRENCY=10 DURATION=1 TPS=500 ./gradlew clean test
        mv results results-out-$i
        aws s3 cp results-out-$i s3://adot-js-testing/perf-result/$hostType/$i --recursive
done