#!/bin/bash

set -e

max=10
for i in `seq 0 $max`
do
        cat results-startup-$i/startup-time-NONE.txt ; echo
done

echo

for i in `seq 0 $max`
do
        cat results-startup-$i/startup-time-OTEL_100.txt ; echo
done

echo

for i in `seq 0 $max`
do
        cat results-startup-$i/startup-time-ADOT_100.txt ; echo
done

echo

for i in `seq 0 $max`
do
        cat results-startup-$i/startup-time-AS_100.txt ; echo
done

echo