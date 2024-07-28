#!/bin/bash

set -ex

npm install --verbose
npm run build --verbose
npm install -g . --verbose

echo "Restarting homebridge"
sudo hb-service restart