const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Serve admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, '-');
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'), false);
    }
  }
});

// Helper functions
function readArticles() {
  try {
    if (!fs.existsSync(ARTICLES_FILE)) {
      const defaultData = { articles: [] };
      fs.writeFileSync(ARTICLES_FILE, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    return JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
  } catch (error) {
    console.error('Error reading articles:', error);
    return { articles: [] };
  }
}

function writeArticles(data) {
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(data, null, 2));
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============= API ROUTES =============
// landing page
app.get('/', (req, res) => {
    res.send('<h1>Welcome to APTA Foundary Admin. Go to /admin to manage All articles</p>');
    });

// GET all articles
app.get('/api/articles', (req, res) => {
  const data = readArticles();
  const articles = data.articles.map(({ content, ...rest }) => rest);
  const sorted = articles.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(sorted);
});

// GET single article
app.get('/api/articles/:slug', (req, res) => {
  const data = readArticles();
  const article = data.articles.find(a => a.slug === req.params.slug);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
});

// CREATE article WITH image (combined)
app.post('/api/articles', upload.single('image'), (req, res) => {
  console.log('\n📝 ===== CREATE ARTICLE WITH IMAGE =====');
  
  const { key, title, category, excerpt, content } = req.body;
  const imageFile = req.file;
  
  console.log('Title:', title);
  console.log('Category:', category);
  console.log('Image file:', imageFile ? imageFile.originalname : 'No image');
  
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
    // Add image at the beginning of content
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
  
 const newArticle = {
    id: Date.now().toString(),
    slug,
    title,
    category,
    date: new Date().toISOString().split('T')[0],
    readTime: '5 min read',
    excerpt,
    content: finalContent,
    featuredImage: imageFile ? `/images/articles/${imageFile.filename}` : null,
    author: {
        name: req.body.authorName || 'APTA Foundry',
        role: req.body.authorRole || ''
    },
    status: 'published'
};
  
  data.articles.push(newArticle);
  writeArticles(data);
  
  console.log('✅ Article created successfully!');
  console.log('   Slug:', slug);
  console.log('   Featured image:', newArticle.featuredImage || 'None');
  console.log('====================================\n');
  
  const { content: _, ...articleWithoutContent } = newArticle;
  res.status(201).json(articleWithoutContent);
});

// UPDATE article (optional with image)
app.put('/api/articles/:slug', upload.single('image'), (req, res) => {
  const { key, title, category, excerpt, content } = req.body;
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Blog API server running on http://localhost:${PORT}`);
  console.log(`📝 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}`);
});