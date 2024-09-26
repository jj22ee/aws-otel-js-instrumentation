'use strict';

const http = require('http');
const express = require('express');

const PORT = parseInt(process.env.SAMPLE_APP_PORT || '5000', 10);

const app = express();

app.get('/health-check', (req, res) => {
  res.send("")
});

app.get('/dep', (req, res) => {
  const httpRequest = http.request('http://simple-service:8081/health-check', (rs) => {
    rs.setEncoding('utf8');
    let responseData = '';
    rs.on('data', dataChunk => (responseData += dataChunk));
    rs.on('end', () => {
      res.send("")
    });

    rs.on('error', console.log);
  }).on('error', (error) => {
    console.log(`Error occurred when making an HTTP request: ${error}`);
    res.status(400).send('(/dep) Error occurred when making an HTTP request');
  });;
  httpRequest.end();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening for requests on http://0.0.0.0:${PORT}`);
});
