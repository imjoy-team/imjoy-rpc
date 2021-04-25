#!/bin/bash

PYTHON_VERSION="$1"
JS_VERSION="$2"

if [ "$PYTHON_VERSION" = "$JS_VERSION" ]; then
    echo "Versions are equal."
    exit 0
else
    echo "Versions are not equal."
    exit 1
fi
