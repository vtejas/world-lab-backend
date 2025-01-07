// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

// Enable trust proxy - Fix for X-Forwarded-For header
app.set('trust proxy', 1);

// Enhanced security headers
app.use(helmet());

// Enable CORS with specific origins
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));

// Compress responses
app.use(compression());

// Custom logging format
morgan.token('req-body', (req) => JSON.stringify(req.body));
app.use(morgan(':method :url :status :response-time ms - :req-body'));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Multer configuration with enhanced validation
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            await fs.mkdir('uploads', { recursive: true });
            cb(null, 'uploads/');
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const fileFilter = (req, file, cb) => {
    // Normalize mime type for images
    const normalizedMimeType = file.mimetype === 'application/octet-stream' 
        ? `image/${path.extname(file.originalname).toLowerCase().slice(1)}` 
        : file.mimetype;

    // Define allowed MIME types and extensions
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    const allowedExtensions = ['.jpeg', '.jpg', '.png', '.gif'];
    
    const extension = path.extname(file.originalname).toLowerCase();
    const isValidMimeType = allowedMimeTypes.includes(normalizedMimeType.toLowerCase());
    const isValidExtension = allowedExtensions.includes(extension);

    // Log validation details
    console.log('File validation:', {
        originalMimeType: file.mimetype,
        normalizedMimeType,
        extension,
        isValidMimeType,
        isValidExtension
    });

    if (isValidMimeType || isValidExtension) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type. Received mimetype: ${normalizedMimeType}, extension: ${extension}. Allowed types: JPEG, PNG and GIF`), false);
    }
};

// Configure multer with error handling
const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 1
    }
}).single('image');

// Wrapper function for better error handling
const uploadMiddleware = (req, res, next) => {
    upload(req, res, function(err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred when uploading
            console.error('Multer error:', err);
            return res.status(400).json({
                status: 'error',
                error: `Upload error: ${err.message}`,
                code: 'MULTER_ERROR'
            });
        } else if (err) {
            // An unknown error occurred
            console.error('Upload error:', err);
            return res.status(400).json({
                status: 'error',
                error: err.message,
                code: 'UPLOAD_ERROR'
            });
        }
        // Everything went fine
        next();
    });
};

// Helper function to encode image
const encodeImage = async (filePath) => {
    try {
        const image = await fs.readFile(filePath);
        return Buffer.from(image).toString('base64');
    } catch (error) {
        throw new Error(`Error encoding image: ${error.message}`);
    }
};

// Helper function to clean up uploaded files
const cleanupFile = async (filePath) => {
    try {
        await fs.unlink(filePath);
        console.log('Successfully cleaned up file:', filePath);
    } catch (error) {
        console.error('Error cleaning up file:', error);
    }
};

// Main analyze endpoint with enhanced error handling
app.post('/analyze', uploadMiddleware, async (req, res) => {
    let filePath = null;
    
    try {
        if (!req.file) {
            throw new Error('No image file provided');
        }
        
        filePath = req.file.path;
        const question = req.body.question || "What is in this image?";
        const base64Image = await encodeImage(filePath);

        // Validate OpenAI API key
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured');
        }

        // Call OpenAI API with timeout
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: question
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 500
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // 30 seconds timeout
            }
        );

        res.json({
            status: 'success',
            response: response.data.choices[0].message.content,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Analysis error:', error);
        
        const errorResponse = {
            status: 'error',
            error: error.message || 'An error occurred during analysis',
            timestamp: new Date().toISOString()
        };

        // Set appropriate status code based on error type
        if (error.response?.status) {
            res.status(error.response.status).json(errorResponse);
        } else if (error.code === 'ECONNABORTED') {
            res.status(504).json({
                ...errorResponse,
                error: 'Request timeout. Please try again.'
            });
        } else if (error.message.includes('file type')) {
            res.status(415).json(errorResponse);
        } else {
            res.status(500).json(errorResponse);
        }

    } finally {
        // Clean up uploaded file
        if (filePath) {
            await cleanupFile(filePath);
        }
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Global error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(err.status || 500).json({
        status: 'error',
        error: process.env.NODE_ENV === 'production' 
            ? 'An unexpected error occurred'
            : err.message,
        timestamp: new Date().toISOString()
    });
});

// Start server with enhanced error handling
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Unhandled rejection handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});