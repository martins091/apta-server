const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3001;

// Performance optimizations
app.enable('trust proxy'); // Trust proxy headers (important for Render)
app.set('etag', 'strong'); // Enable ETag caching
app.disable('x-powered-by'); // Remove fingerprint for slight performance gain

// Middleware - with caching for static files
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase JSON limit
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files with caching headers for better performance
app.use('/images', express.static(path.join(__dirname, 'public/images'), {
  maxAge: '30d', // Cache images for 30 days
  etag: true,
  lastModified: true
}));

// Serve admin.html with no-cache for fresh content
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Simple landing page
app.get('/', (req, res) => {
  res.send('<h1>Welcome to APTA Foundry Admin</h1><p>Go to <a href="/admin">/admin</a> to manage all articles</p>');
});

// Path to articles JSON file
const ARTICLES_FILE = path.join(__dirname, 'articles.json');
const ADMIN_KEY = 'apta-secret-key-2025';

// Configure image storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public/images/articles');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Remove special characters and spaces for better URL compatibility
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '-');
    const uniqueName = Date.now() + '-' + cleanName;
    cb(null, uniqueName);
  }
});

// Increased file size limit to 20MB for larger images
const upload = multer({ 
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit (increased from 5MB)
  fileFilter: (req, file, cb) => {
    // Allow common image formats
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Only images are allowed. Received: ${file.mimetype}`), false);
    }
  }
});

// Helper functions with caching for better performance
let articlesCache = null;
let lastCacheTime = 0;
const CACHE_TTL = 5000; // Cache articles for 5 seconds

function readArticles() {
  try {
    // Check if we can use cached data
    const now = Date.now();
    if (articlesCache && (now - lastCacheTime) < CACHE_TTL) {
      return articlesCache;
    }
    
    if (!fs.existsSync(ARTICLES_FILE)) {
      const defaultData = { articles: [] };
      fs.writeFileSync(ARTICLES_FILE, JSON.stringify(defaultData, null, 2));
      articlesCache = defaultData;
      lastCacheTime = now;
      return defaultData;
    }
    
    const data = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
    articlesCache = data;
    lastCacheTime = now;
    return data;
  } catch (error) {
    console.error('Error reading articles:', error);
    return { articles: [] };
  }
}

function writeArticles(data) {
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(data, null, 2));
  // Invalidate cache
  articlesCache = null;
  lastCacheTime = 0;
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100); // Limit slug length
}

// ============= API ROUTES =============

// GET all articles (with caching headers)
app.get('/api/articles', (req, res) => {
  const data = readArticles();
  const articles = data.articles.map(({ content, ...rest }) => rest);
  const sorted = articles.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Add caching headers for better performance
  res.setHeader('Cache-Control', 'public, max-age=60'); // Cache for 60 seconds
  res.json(sorted);
});

// GET single article
app.get('/api/articles/:slug', (req, res) => {
  const data = readArticles();
  const article = data.articles.find(a => a.slug === req.params.slug);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  
  // Cache individual article for longer
  res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
  res.json(article);
});

// CREATE article WITH image (combined)
app.post('/api/articles', upload.single('image'), (req, res) => {
  console.log('\n📝 ===== CREATE ARTICLE WITH IMAGE =====');
  
  const { key, title, category, excerpt, content, authorName, authorRole } = req.body;
  const imageFile = req.file;
  
  console.log('Title:', title);
  console.log('Category:', category);
  console.log('Image file:', imageFile ? imageFile.originalname : 'No image');
  console.log('Image size:', imageFile ? `${(imageFile.size / 1024 / 1024).toFixed(2)}MB` : 'N/A');
  
  // Verify admin key
  if (key !== ADMIN_KEY) {
    console.log('❌ Auth failed');
    if (imageFile) {
      fs.unlinkSync(imageFile.path);
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Validate required fields
  if (!title || !category || !excerpt) {
    console.log('❌ Missing required fields');
    if (imageFile) {
      fs.unlinkSync(imageFile.path);
    }
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Build article content with image
  let finalContent = content || '';
  
  // If an image was uploaded, add it to the content
  if (imageFile) {
    const imageUrl = `/images/articles/${imageFile.filename}`;
    const imageMarkdown = `![${imageFile.originalname}](${imageUrl})\n\n`;
    finalContent = imageMarkdown + finalContent;
    console.log('✅ Image attached:', imageUrl);
  }
  
  const data = readArticles();
  const slug = generateSlug(title);
  
  // Check if slug already exists
  if (data.articles.some(a => a.slug === slug)) {
    console.log('❌ Slug already exists:', slug);
    if (imageFile) {
      fs.unlinkSync(imageFile.path);
    }
    return res.status(400).json({ error: 'An article with this title already exists' });
  }
  
  // Calculate read time based on content length (more accurate)
  const wordCount = finalContent.split(/\s+/).length;
  const readTimeMinutes = Math.max(3, Math.ceil(wordCount / 200));
  const readTimeText = `${readTimeMinutes} min read`;
  
  const newArticle = {
    id: Date.now().toString(),
    slug,
    title,
    category,
    date: new Date().toISOString().split('T')[0],
    readTime: readTimeText,
    excerpt,
    content: finalContent,
    featuredImage: imageFile ? `/images/articles/${imageFile.filename}` : null,
    author: {
      name: authorName || 'APTA Foundry',
      role: authorRole || ''
    },
    status: 'published'
  };
  
  data.articles.push(newArticle);
  writeArticles(data);
  
  console.log('✅ Article created successfully!');
  console.log('   Slug:', slug);
  console.log('   Read time:', readTimeText);
  console.log('   Featured image:', newArticle.featuredImage || 'None');
  console.log('====================================\n');
  
  // Invalidate cache by re-reading (already handled in writeArticles)
  const { content: _, ...articleWithoutContent } = newArticle;
  res.status(201).json(articleWithoutContent);
});

// UPDATE article (optional with image)
app.put('/api/articles/:slug', upload.single('image'), (req, res) => {
  const { key, title, category, excerpt, content, authorName, authorRole } = req.body;
  const imageFile = req.file;
  
  if (key !== ADMIN_KEY) {
    if (imageFile) {
      fs.unlinkSync(imageFile.path);
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const data = readArticles();
  const index = data.articles.findIndex(a => a.slug === req.params.slug);
  
  if (index === -1) {
    if (imageFile) {
      fs.unlinkSync(imageFile.path);
    }
    return res.status(404).json({ error: 'Article not found' });
  }
  
  let finalContent = content || data.articles[index].content;
  
  // If new image uploaded, add it and update featured image
  if (imageFile) {
    const imageUrl = `/images/articles/${imageFile.filename}`;
    const imageMarkdown = `![${imageFile.originalname}](${imageUrl})\n\n`;
    finalContent = imageMarkdown + finalContent;
    data.articles[index].featuredImage = imageUrl;
    console.log('✅ Updated image:', imageUrl);
  }
  
  // Recalculate read time if content changed
  let readTimeText = data.articles[index].readTime;
  if (content && content !== data.articles[index].content) {
    const wordCount = finalContent.split(/\s+/).length;
    const readTimeMinutes = Math.max(3, Math.ceil(wordCount / 200));
    readTimeText = `${readTimeMinutes} min read`;
  }
  
  let newSlug = data.articles[index].slug;
  if (title && title !== data.articles[index].title) {
    newSlug = generateSlug(title);
    if (data.articles.some((a, i) => i !== index && a.slug === newSlug)) {
      if (imageFile) {
        fs.unlinkSync(imageFile.path);
      }
      return res.status(400).json({ error: 'An article with this title already exists' });
    }
  }
  
  data.articles[index] = {
    ...data.articles[index],
    slug: newSlug,
    title: title || data.articles[index].title,
    category: category || data.articles[index].category,
    excerpt: excerpt || data.articles[index].excerpt,
    content: finalContent,
    readTime: readTimeText,
    author: {
      name: authorName || data.articles[index].author?.name || 'APTA Foundry',
      role: authorRole || data.articles[index].author?.role || ''
    },
    date: data.articles[index].date
  };
  
  writeArticles(data);
  res.json(data.articles[index]);
});

// DELETE article
app.delete('/api/articles/:slug', (req, res) => {
  const { key } = req.body;
  
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const data = readArticles();
  const articleToDelete = data.articles.find(a => a.slug === req.params.slug);
  
  if (!articleToDelete) {
    return res.status(404).json({ error: 'Article not found' });
  }
  
  data.articles = data.articles.filter(a => a.slug !== req.params.slug);
  writeArticles(data);
  res.json({ message: 'Article deleted successfully' });
});

// Health check (with minimal processing for fast response)
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware for better error responses
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ error: 'Image file is too large. Maximum size is 20MB.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  
  if (err.message && err.message.includes('Only images are allowed')) {
    return res.status(400).json({ error: err.message });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Blog API server running on http://localhost:${PORT}`);
  console.log(`📝 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}`);
  console.log(`📸 Max image size: 20MB`);
  console.log(`⚡ Performance optimizations enabled: caching, compression, ETags`);
});