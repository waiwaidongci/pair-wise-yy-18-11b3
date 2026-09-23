'use strict';

const express = require('express');
const path = require('path');
const config = require('./project.config');
const { Repository } = require('./src/repository');
const { SubstitutionService } = require('./src/substitution-service');
const { buildGenericRouter } = require('./src/generic-routes');
const { buildSubstitutionRouter } = require('./src/substitution-routes');

const app = express();
const PORT = process.env.PORT || config.port;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'app.json');

app.use(express.json({ limit: '2mb' }));

// 持久化 + 业务判定模块（路由不直接操作存储）
const repo = new Repository(config, DB_FILE);
repo.init();
const substitutionService = new SubstitutionService(repo);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 业务专用路由须先于通用 /:collection/:id 注册
app.use('/api', buildSubstitutionRouter(substitutionService));
app.use('/api', buildGenericRouter(repo, config));

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const body = { error: error.message || 'server error' };
  if (error.code) body.code = error.code;
  if (status >= 500) console.error(error);
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});

module.exports = app;
