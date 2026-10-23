const { createApp } = require('./app');

const PORT = process.env.PORT || 4000;

let app;
try {
  app = createApp(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}`);
  console.log(`enabled tools: ${app.locals.enabledTools.map((t) => t.slug).join(', ') || '(none)'}`);
});
