#!/bin/bash
pm2 delete Universal-DRM
pm2 --name Universal-DRM start npm -- start
