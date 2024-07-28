#!/bin/bash

set -ex

git pull

npm install
npm run build
npm install -g .

echo "Restarting homebridge"
sudo hb-service restart
