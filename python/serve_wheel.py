#!/usr/bin/env python3
# encoding: utf-8
"""This script is used for debugging imjoy in Pyodide locally.

Use instead of `python3 -m http.server` when you need CORS.
"""
import os

os.system("python3 setup.py bdist_wheel")

os.chdir("./dist")

print("Running server at http://127.0.0.1:8003")
from http.server import HTTPServer, SimpleHTTPRequestHandler  # noqa: E402


class CORSRequestHandler(SimpleHTTPRequestHandler):
    """Represent a CORS request handler."""

    def end_headers(self):
        """Return end headers."""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        return super(CORSRequestHandler, self).end_headers()


httpd = HTTPServer(("localhost", 8003), CORSRequestHandler)
httpd.serve_forever()
