#!/usr/bin/env node
/**
 * List all available Gemini models for your API key
 * Usage: node list-models.js YOUR_API_KEY
 */
const apiKey = process.argv[2];
if (!apiKey) { console.error('Usage: node list-models.js YOUR_GEMINI_API_KEY'); process.exit(1); }

(async () => {
  console.log('=== Listing all available Gemini models ===\n');

  let nextPageToken = '';
  const allModels = [];

  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Error:', await res.text());
      process.exit(1);
    }
    const data = await res.json();
    allModels.push(...(data.models || []));
    nextPageToken = data.nextPageToken || '';
  } while (nextPageToken);

  // Filter for image-related models
  const imageModels = allModels.filter(m =>
    m.name.toLowerCase().includes('image') ||
    m.name.toLowerCase().includes('imagen') ||
    m.supportedGenerationMethods?.some(method => method.includes('image') || method.includes('predict'))
  );

  console.log(`Total models available: ${allModels.length}`);
  console.log(`\n--- Image-related models ---`);
  if (imageModels.length === 0) {
    console.log('(none found)');
  } else {
    imageModels.forEach(m => {
      console.log(`\n  📷 ${m.name}`);
      console.log(`     Display: ${m.displayName || '-'}`);
      console.log(`     Methods: ${(m.supportedGenerationMethods || []).join(', ')}`);
    });
  }

  console.log(`\n--- All model names ---`);
  allModels.forEach(m => {
    const methods = (m.supportedGenerationMethods || []).join(', ');
    const flag = m.name.toLowerCase().includes('image') || m.name.toLowerCase().includes('imagen') ? ' 📷' : '';
    console.log(`  ${m.name} [${methods}]${flag}`);
  });
})();
