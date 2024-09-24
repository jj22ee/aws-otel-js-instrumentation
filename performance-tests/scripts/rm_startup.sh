#!/bin/bash

set -e

max=10
for i in `seq 0 $max`
do
        rm -rf results-startup-$i
done