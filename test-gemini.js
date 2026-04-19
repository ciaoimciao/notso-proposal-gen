#!/usr/bin/env node
/**
 * Test script to find which Gemini image generation model works with your API key.
 * Usage: node test-gemini.js YOUR_API_KEY
 */

const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node test-gemini.js YOUR_GEMINI_API_KEY');
  process.exit(1);
}

const models = [
  // generateContent models (responseModalities approach)
  { name: 'gemini-2.0-flash-exp-image-generation', type: 'generateContent' },
  { name: 'gemini-2.0-flash-exp', type: 'generateContent' },
  { name: 'gemini-2.5-flash-preview-image-generation', type: 'generateContent' },
  { name: 'gemini-2.5-flash', type: 'generateContent' },
  { name: 'gemini-2.5-pro-exp-03-25', type: 'generateContent' },
  // Imagen models (predict approach)
  { name: 'imagen-3.0-generate-002', type: 'predict' },
  { name: 'imagen-3.0-generate-001', type: 'predict' },
];

const prompt = 'A cute 3D blue cat mascot, clay toy style, transparent background, simple pose';

async function testModel(model) {
  const label = `${model.name} (${model.type})`;
  try {
    let url, body, headers;

    if (model.type === 'generateContent') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`;
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      });
    } else {
      // predict (Imagen)
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:predict`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
      body = JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1 }
      });
    }

    console.log(`\n🔄 Testing: ${label}...`);
    const res = await fetch(url, { method: 'POST', headers, body });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`   ❌ ${res.status}: ${errText.slice(0, 300)}`);
      return false;
    }

    const data = await res.json();

    if (model.type === 'generateContent') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const hasImage = parts.some(p => p.inlineData);
      if (hasImage) {
        console.log(`   ✅ SUCCESS! Image generated!`);
        return true;
      } else {
        console.log(`   ⚠️  OK response but no image data. Parts:`, parts.map(p => Object.keys(p)));
        return false;
      }
    } else {
      const predictions = data.predictions || [];
      if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
        console.log(`   ✅ SUCCESS! Image generated!`);
        return true;
      } else {
        console.log(`   ⚠️  OK response but no predictions.`, JSON.stringify(data).slice(0, 200));
        return false;
      }
    }
  } catch (err) {
    console.log(`   ❌ Error: ${err.message}`);
    return false;
  }
}

(async () => {
  console.log('=== Gemini Image Generation Model Tester ===');
  console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`Testing ${models.length} models...\n`);

  const working = [];
  for (const model of models) {
    const ok = await testModel(model);
    if (ok) working.push(model.name);
  }

  console.log('\n\n=== RESULTS ===');
  if (working.length > 0) {
    console.log('✅ Working models:', working.join(', '));
  } else {
    console.log('❌ No models worked. Possible issues:');
    console.log('   1. API key may not have image generation enabled');
    console.log('   2. Free tier may not include image generation');
    console.log('   3. API key may need billing enabled');
    console.log('   4. Region restriction (image gen may not be available in all regions)');
    console.log('\n   → Go to https://aistudio.google.com/apikey to check your key');
    console.log('   → Try enabling billing at https://console.cloud.google.com/billing');
  }
})();
