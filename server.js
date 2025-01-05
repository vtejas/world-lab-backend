// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const OpenAI = require('openai');

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Enable CORS
app.use(cors());
app.use(morgan('dev'));

// Configure multer for handling file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') // Make sure this directory exists
    },
    filename: function (req, file, cb) {
        // Create unique filename with original extension
        cb(null, Date.now() + path.extname(file.originalname))
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept images only
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
            return cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
    }
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Function to encode image to base64
function encodeImage(imagePath) {
    const image = fs.readFileSync(imagePath);
    return image.toString('base64');
}

// Function to extract JSON from GPT-4 response
function extractJsonFromResponse(text) {
    try {
        // Try to parse the entire response first
        return JSON.parse(text);
    } catch (e) {
        try {
            // Remove markdown code blocks if present
            const jsonStr = text.replace(/```json\n|\n```|```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (e2) {
            try {
                // Try to find JSON array in the text
                const match = text.match(/\[[\s\S]*\]/);
                if (match) {
                    return JSON.parse(match[0]);
                }
            } catch (e3) {
                console.error('Failed to parse JSON:', text);
                // Return a formatted error object that the app can handle
                return [{
                    label: "Error parsing objects",
                    confidence: 0
                }];
            }
        }
    }
}

// Function to analyze image using GPT-4-Vision
async function analyzeImage(imagePath) {
    try {
        const base64Image = encodeImage(imagePath);

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "List all visible objects in this image. Return ONLY a JSON array of objects with labels and confidence scores. Example format: [{\"label\": \"car\", \"confidence\": 0.95}]. No other text or markdown formatting."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ]
        });

        console.log('Raw GPT response:', response.choices[0].message.content);
        
        // Extract and parse the JSON from the response
        const detectedObjects = extractJsonFromResponse(response.choices[0].message.content);
        
        console.log('Parsed objects:', detectedObjects);
        
        return detectedObjects;

    } catch (error) {
        console.error('Error analyzing image:', error);
        // Return a formatted error that the app can handle
        return [{
            label: `Error: ${error.message}`,
            confidence: 0
        }];
    }
}

// Handle image upload and analysis
app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        // Analyze the image using GPT-4-Vision
        const objects = await analyzeImage(req.file.path);
        
        // Return the analysis results
        res.json({
            message: 'File uploaded and analyzed successfully',
            file: req.file,
            objects: objects
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: error.message,
            objects: [{
                label: `Error: ${error.message}`,
                confidence: 0
            }]
        });
    }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});