/**
 * Distinct curricula, lessons, assignments, and quizzes for every course on Peleekings.
 * Each course has tailored modules, specific learning objectives, practical assignments, and quiz assessments.
 */

export const COURSE_CURRICULA = {
  "ai-essentials": {
    modules: [
      {
        id: "m1",
        title: "Module 01 - Foundations of AI & Machine Learning",
        lessons: [
          { id: "ai_l1", title: "1. What is Artificial Intelligence?", duration: "10 min", completed: false, type: "video" },
          { id: "ai_l2", title: "2. Neural Networks & Large Language Models", duration: "15 min", completed: false, type: "video" },
          { id: "ai_l3", title: "3. Prompt Engineering & Zero-Shot Framing", duration: "18 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "m2",
        title: "Module 02 - Applied AI Tools & Automation",
        lessons: [
          { id: "ai_l4", title: "4. Working with ChatGPT, Claude & Copilot", duration: "14 min", completed: false, type: "video" },
          { id: "ai_l5", title: "5. Structured Data Extraction & Formatting", duration: "12 min", completed: false, type: "video" },
          { id: "ai_l6", title: "6. Automation with Zapier & Make Webhooks", duration: "25 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "m3",
        title: "Module 03 - Enterprise Pipelines & Capstone",
        lessons: [
          { id: "ai_l7", title: "7. Multi-Agent Systems & API Integrations", duration: "20 min", completed: false, type: "video" },
          { id: "ai_l8", title: "8. Capstone Assessment: AI Pipeline Architecture", duration: "35 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Learn how modern AI models operate and how to construct automated workflows that eliminate manual data processing, streamline customer touchpoints, and integrate intelligent agents into everyday business operations.",
      objectives: [
        "Master zero-shot, few-shot, and chain-of-thought prompt techniques",
        "Connect AI APIs to Zapier, Make, and webhook endpoints for automated processing",
        "Implement guardrails and schema validation for reliable JSON data outputs",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: Prompt Chain & Zapier Pipeline",
      description: "Design an automated workflow that takes an incoming text input (e.g. customer feedback), uses an AI prompt to classify sentiment and extract action items into JSON, and passes the output to a spreadsheet or webhook. Submit your Zapier/Make share link or your multi-step JSON prompt template below.",
      placeholder: "Paste your Zapier/Make share URL or your structured multi-step prompt design here...",
    },
    quizQuestions: [
      {
        question: "Which prompting technique guarantees structured JSON output from large language models?",
        options: [
          "Few-shot prompting with explicit JSON schema examples",
          "Zero-shot prompting with maximum temperature setting",
          "Open-ended conversational prompts without output constraints",
          "Repeating the question multiple times in a single message",
        ],
        correctIndex: 0,
      },
      {
        question: "What is the primary role of a webhook in an automated AI pipeline?",
        options: [
          "To store video assets in cold cloud storage",
          "To transmit real-time event payloads instantly between web applications",
          "To compress images before sending to local printers",
          "To measure computer memory bandwidth",
        ],
        correctIndex: 1,
      },
      {
        question: "Which security practice is mandatory when deploying automated AI scripts?",
        options: [
          "Committing API secrets to public code repositories",
          "Storing API keys in secure server-side environment variables",
          "Embedding secret tokens in front-end HTML meta tags",
          "Sharing credentials via unencrypted instant messages",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "AI_Essentials_and_Automation_Study_Notes.pdf",
  },

  "computer-basics": {
    modules: [
      {
        id: "cb_m1",
        title: "Module 01 - Computer Hardware & Operating Systems",
        lessons: [
          { id: "cb_l1", title: "1. Hardware Architecture: CPU, RAM & Storage", duration: "12 min", completed: false, type: "video" },
          { id: "cb_l2", title: "2. Navigating Operating Systems & Files", duration: "15 min", completed: false, type: "video" },
          { id: "cb_l3", title: "3. System Settings, Security & Peripheral Devices", duration: "16 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "cb_m2",
        title: "Module 02 - Digital Productivity & Office Suites",
        lessons: [
          { id: "cb_l4", title: "4. Professional Word Processing & Document Design", duration: "18 min", completed: false, type: "video" },
          { id: "cb_l5", title: "5. Spreadsheet Fundamentals: Formulas & Tables", duration: "20 min", completed: false, type: "video" },
          { id: "cb_l6", title: "6. Practical Exercise: Monthly Financial Spreadsheet", duration: "25 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "cb_m3",
        title: "Module 03 - Cloud Services & Cyber Safety",
        lessons: [
          { id: "cb_l7", title: "7. Web Browsers, Cloud Sync & Google Drive", duration: "15 min", completed: false, type: "video" },
          { id: "cb_l8", title: "8. Computing Literacy & Cyber Hygiene Assessment", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Build an rock-solid foundation in modern computing. Understand how computer components work together, master file management in Windows and macOS, gain proficiency in professional office tools, and develop safe internet practices.",
      objectives: [
        "Distinguish between primary memory (RAM), storage (SSD/HDD), and processors",
        "Create organized hierarchical folders and master file compression and backup",
        "Formulate calculation spreadsheets with SUM, AVERAGE, and conditional formatting",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: Structured Budget Spreadsheet",
      description: "Create a monthly personal or small business expense spreadsheet containing at least 5 expense categories, sub-totals using the SUM formula, an average monthly expense calculation, and formatted currency cells. Paste a link to your Google Sheets document or outline your table formula structure below.",
      placeholder: "Share your Google Sheets link (view access) or describe your formula architecture and rows...",
    },
    quizQuestions: [
      {
        question: "What is the primary operational difference between RAM and storage (SSD/HDD)?",
        options: [
          "RAM provides volatile temporary memory for running apps, while SSD stores persistent data",
          "RAM stores files permanently even when power is turned off",
          "Storage drives are significantly faster than RAM modules",
          "RAM is exclusively used for playing audio files",
        ],
        correctIndex: 0,
      },
      {
        question: "In spreadsheet software (Excel/Sheets), which formula correctly adds numbers in cells B2 through B10?",
        options: [
          "=TOTAL(B2:B10)",
          "=SUM(B2:B10)",
          "=ADD(B2..B10)",
          "=COUNT(B2:B10)",
        ],
        correctIndex: 1,
      },
      {
        question: "Which of the following describes a secure password practice?",
        options: [
          "Using your year of birth across all internet accounts",
          "A unique passphrase with uppercase, numbers, and symbols stored in a password manager",
          "Writing your password on a sticky note attached to your computer monitor",
          "Using the word 'password123' so you never forget it",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Computer_Basics_and_Literacy_Handbook.pdf",
  },

  photography: {
    modules: [
      {
        id: "photo_m1",
        title: "Module 01 - Camera Mechanics & Exposure",
        lessons: [
          { id: "photo_l1", title: "1. The Exposure Triangle: Aperture, Shutter & ISO", duration: "14 min", completed: false, type: "video" },
          { id: "photo_l2", title: "2. Optics, Focal Lengths & Depth of Field", duration: "16 min", completed: false, type: "video" },
          { id: "photo_l3", title: "3. Manual Shooting: Metering Modes & Dynamic Range", duration: "18 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "photo_m2",
        title: "Module 02 - Lighting Techniques & Composition",
        lessons: [
          { id: "photo_l4", title: "4. Three-Point Lighting & Light Modifiers", duration: "20 min", completed: false, type: "video" },
          { id: "photo_l5", title: "5. Composition: Rule of Thirds, Leading Lines & Symmetry", duration: "15 min", completed: false, type: "video" },
          { id: "photo_l6", title: "6. Practical Assignment: 3-Shot Exposure Study", duration: "30 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "photo_m3",
        title: "Module 03 - RAW Curation & Color Grading",
        lessons: [
          { id: "photo_l7", title: "7. RAW Workflow, Color Curves & Lightroom", duration: "18 min", completed: false, type: "video" },
          { id: "photo_l8", title: "8. Photography & Studio Lighting Mastery Assessment", duration: "25 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Master manual camera controls and discover how to sculpt scenes using natural and artificial light. Learn how aperture, shutter speed, and ISO interact to create clean, sharp, cinematic photographs in both indoor and outdoor environments.",
      objectives: [
        "Balance the exposure triangle manually for any ambient lighting condition",
        "Position key, fill, and rim lights to create depth and eliminate unwanted shadows",
        "Execute color balance and tonal curve enhancements on uncompressed RAW images",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 3-Shot Exposure & Composition Study",
      description: "Capture and submit 3 photos demonstrating distinct photographic principles: (1) Shallow depth of field with a wide aperture (e.g. f/1.8 - f/2.8), (2) Motion freeze or motion blur with shutter speed manipulation, and (3) A directional portrait using primary key lighting and soft fill. Submit your image links (Google Drive, Dropbox, or Behance).",
      placeholder: "Provide links to your 3 photos along with your camera settings (Aperture, Shutter, ISO)...",
    },
    quizQuestions: [
      {
        question: "Widening your camera lens aperture from f/8 to f/2.8 will have which effect?",
        options: [
          "It decreases light intake and increases depth of field",
          "It allows more light into the sensor and creates a shallower depth of field (blurry background)",
          "It forces the shutter speed to become extremely slow",
          "It converts the image directly into black and white",
        ],
        correctIndex: 1,
      },
      {
        question: "To freeze fast-moving action (e.g., sports or running subjects) without motion blur, which shutter speed is best?",
        options: [
          "1/15 of a second",
          "1/2 of a second",
          "1/1000 of a second or faster",
          "2 full seconds",
        ],
        correctIndex: 2,
      },
      {
        question: "What is the primary function of a 'Fill Light' in a traditional three-point lighting setup?",
        options: [
          "To illuminate the camera lens directly",
          "To soften and lighten the harsh shadows created by the Key Light",
          "To color the background completely black",
          "To provide backlighting that separates the subject from the backdrop",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Photography_and_Studio_Lighting_Masterclass.pdf",
  },

  videography: {
    modules: [
      {
        id: "video_m1",
        title: "Module 01 - Cinematic Camera Movement & Framing",
        lessons: [
          { id: "video_l1", title: "1. Frame Rates, Shutter Angles & 24fps Cinematics", duration: "16 min", completed: false, type: "video" },
          { id: "video_l2", title: "2. Camera Motion: Gimbals, Tracking & Pan Control", duration: "18 min", completed: false, type: "video" },
          { id: "video_l3", title: "3. Professional Audio Capture: Shotgun & Lavalier Mics", duration: "15 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "video_m2",
        title: "Module 02 - Non-Linear Editing in Premiere & DaVinci",
        lessons: [
          { id: "video_l4", title: "4. Timeline Assembly, J-Cuts, L-Cuts & Visual Rhythm", duration: "22 min", completed: false, type: "video" },
          { id: "video_l5", title: "5. Sound Design: Room Tone, Foley & Dialogue Leveling", duration: "20 min", completed: false, type: "video" },
          { id: "video_l6", title: "6. Practical Assignment: Cut a 60-Second Promotional Reel", duration: "35 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "video_m3",
        title: "Module 03 - Color Grading & Final Delivery",
        lessons: [
          { id: "video_l7", title: "7. Color Correction, Waveforms, LUTs & Grading", duration: "25 min", completed: false, type: "video" },
          { id: "video_l8", title: "8. Videography & Video Editing Mastery Assessment", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "From storyboard to final color grade, master the craft of cinematic video storytelling. Learn camera movement techniques, audio synchronization, non-linear video editing, and color balance that make video productions look broadcast-ready.",
      objectives: [
        "Shoot cinematic video following the 180-degree shutter rule at 24fps and 60fps",
        "Assemble engaging edits utilizing J-cuts, L-cuts, and seamless B-roll cutaways",
        "Color grade footage using waveform scopes, primary wheels, and conversion LUTs",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 60-Second Video Reel Cut",
      description: "Edit and export a 60-second video piece (commercial, interview snippet, or cinematic montage). Include background music balanced under dialogue (-18dB to -12dB dialogue peak), at least two B-roll cutaways, and basic color correction. Submit your YouTube unlisted or Google Drive link below.",
      placeholder: "Paste your video link (YouTube unlisted, Vimeo, or Google Drive) with a brief project summary...",
    },
    quizQuestions: [
      {
        question: "According to the cinematic 180-degree shutter rule, if shooting at 24 frames per second, what should your shutter speed be?",
        options: [
          "1/24 of a second",
          "1/50 of a second (nearest to double the frame rate)",
          "1/250 of a second",
          "1/1000 of a second",
        ],
        correctIndex: 1,
      },
      {
        question: "In video editing, what occurs during an 'L-Cut' transition?",
        options: [
          "The audio from the previous scene continues playing under the video of the new scene",
          "The video cut happens simultaneously with audio cut",
          "The video changes while the entire screen fades to white",
          "The camera physically tilts to the left",
        ],
        correctIndex: 0,
      },
      {
        question: "What tool in Premiere Pro or DaVinci Resolve is used to monitor highlight clipping and shadow crush scientifically?",
        options: [
          "The Audio Gain dial",
          "Waveform and Vectorscope video scopes",
          "The crop effect",
          "The file directory tree",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Cinematic_Videography_and_Editing_Guide.pdf",
  },

  "sound-production": {
    modules: [
      {
        id: "sound_m1",
        title: "Module 01 - Studio Acoustics & Microphone Science",
        lessons: [
          { id: "sound_l1", title: "1. The Physics of Audio: Frequencies, Amplitudes & Phase", duration: "14 min", completed: false, type: "video" },
          { id: "sound_l2", title: "2. Microphone Types: Dynamic, Condenser & Polar Patterns", duration: "16 min", completed: false, type: "video" },
          { id: "sound_l3", title: "3. Audio Interfaces, Gain Staging & Signal Flow", duration: "18 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "sound_m2",
        title: "Module 02 - DAW Multitrack Recording & Mixing",
        lessons: [
          { id: "sound_l4", title: "4. Setting Up DAW Sessions & Multitrack Tracking", duration: "18 min", completed: false, type: "video" },
          { id: "sound_l5", title: "5. Equalization (EQ), Compression & Noise Gates", duration: "24 min", completed: false, type: "video" },
          { id: "sound_l6", title: "6. Practical Assignment: Multitrack Vocal & Beat Mix", duration: "30 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "sound_m3",
        title: "Module 03 - Spatial Depth & Mastering Standards",
        lessons: [
          { id: "sound_l7", title: "7. Reverb, Delay, Stereo Imaging & LUFS Standards", duration: "20 min", completed: false, type: "video" },
          { id: "sound_l8", title: "8. Audio Engineering Certification Quiz", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Learn professional audio engineering and music production from initial microphone placement to final streaming loudness mastering. Understand acoustics, dynamic range control, equalization, and spatial effects in modern Digital Audio Workstations.",
      objectives: [
        "Select and place microphones according to cardioid, figure-8, and omni patterns",
        "Clean vocal resonance and apply compression with proper attack and release times",
        "Master tracks to international streaming loudness benchmarks (-14 LUFS integrated)",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 2-Track Audio Mixdown",
      description: "Download the sample vocal and background track (or record your own voiceover with background music). Apply EQ high-pass filtering (cutting rumble below 80Hz), balance vocal levels, duck the music under speech using sidechain or volume automation, and export as 24-bit WAV or high-quality MP3. Share your SoundCloud, Drive, or Dropbox link.",
      placeholder: "Paste the streaming link or Google Drive URL for your mixed audio file...",
    },
    quizQuestions: [
      {
        question: "Which microphone polar pattern rejects sound coming from directly behind the capsule while capturing sound from the front?",
        options: [
          "Omnidirectional",
          "Cardioid",
          "Figure-8 (Bidirectional)",
          "Boundary",
        ],
        correctIndex: 1,
      },
      {
        question: "What is the primary function of a High-Pass Filter (Low-Cut) on a vocal channel?",
        options: [
          "To boost vocal air frequencies above 12,000 Hz",
          "To eliminate unwanted sub-bass rumble, microphone thumps, and AC hum below 80 Hz",
          "To double the overall loudness of the recording",
          "To invert the phase of the audio waveform",
        ],
        correctIndex: 1,
      },
      {
        question: "What is the standard integrated loudness target for music and podcasts on Spotify and YouTube?",
        options: [
          "0 dBFS peak",
          "-14 LUFS integrated",
          "-30 LUFS integrated",
          "+6 dBU analog",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Studio_Audio_Engineering_Handbook.pdf",
  },

  "graphic-design": {
    modules: [
      {
        id: "gd_m1",
        title: "Module 01 - Visual Principles & Typography",
        lessons: [
          { id: "gd_l1", title: "1. Hierarchy, Contrast, Proximity & Balance", duration: "15 min", completed: false, type: "video" },
          { id: "gd_l2", title: "2. Type Anatomy: Kerning, Leading & Font Pairing", duration: "16 min", completed: false, type: "video" },
          { id: "gd_l3", title: "3. Color Theory: Harmonies, Gamuts & Psychology", duration: "14 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "gd_m2",
        title: "Module 02 - Vector Artwork & Brand Identity",
        lessons: [
          { id: "gd_l4", title: "4. Vector Geometry & Pen Tool Precision", duration: "22 min", completed: false, type: "video" },
          { id: "gd_l5", title: "5. Logo Design, Grid Systems & Brand Marks", duration: "20 min", completed: false, type: "video" },
          { id: "gd_l6", title: "6. Practical Assignment: Design a Social Media Brand Kit", duration: "35 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "gd_m3",
        title: "Module 03 - Layout Design & Print Delivery",
        lessons: [
          { id: "gd_l7", title: "7. Editorial Layouts, Bleeds, Margins & CMYK Export", duration: "18 min", completed: false, type: "video" },
          { id: "gd_l8", title: "8. Graphic Design Principles & Typography Assessment", duration: "25 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Master modern visual communication. Develop the discerning eye of a senior art director as you study typography, color psychology, vector illustration, and layout design systems across both screen and print media.",
      objectives: [
        "Structure layout compositions with unambiguous visual focal points and hierarchy",
        "Pair serif, sans-serif, and display typefaces with harmonious tracking and leading",
        "Construct scalable vector branding kits and prepare print-ready press PDFs",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 3-Slide Brand Kit & Social Post",
      description: "Create a visual identity kit for a brand: (1) Primary Logo with color variants, (2) Selected typeface combination (Header + Body font), and (3) A 1080x1080 Instagram post template featuring photography, headline typography, and a brand badge. Submit your Figma, Canva, or Behance project link.",
      placeholder: "Provide your Figma file link, Behance presentation, or image link...",
    },
    quizQuestions: [
      {
        question: "When preparing artwork intended strictly for physical paper printing, which color profile should be utilized?",
        options: [
          "RGB (Red, Green, Blue)",
          "CMYK (Cyan, Magenta, Yellow, Black)",
          "HEX color notation",
          "HSL (Hue, Saturation, Lightness)",
        ],
        correctIndex: 1,
      },
      {
        question: "What does the typographic term 'Kerning' describe?",
        options: [
          "The vertical space between two consecutive lines of text",
          "The proportional adjustment of space between two individual letter characters",
          "The slant angle of italicized characters",
          "The thickness of a font stroke",
        ],
        correctIndex: 1,
      },
      {
        question: "Why are SVG and AI vector files preferred over PNG/JPEG for company logos?",
        options: [
          "They cannot be opened on mobile devices",
          "Vectors are based on mathematical paths and scale infinitely without pixelation",
          "They have larger file sizes than any video format",
          "They only support two colors",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Graphic_Design_Foundations_and_Typography.pdf",
  },

  "social-media": {
    modules: [
      {
        id: "sm_m1",
        title: "Module 01 - Algorithms & Target Audience Mapping",
        lessons: [
          { id: "sm_l1", title: "1. Inside Social Feeds: TikTok, Instagram & YouTube", duration: "15 min", completed: false, type: "video" },
          { id: "sm_l2", title: "2. Audience Personas & The 4 Core Content Pillars", duration: "18 min", completed: false, type: "video" },
          { id: "sm_l3", title: "3. Competitive Benchmarking & Content Audits", duration: "16 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "sm_m2",
        title: "Module 02 - Viral Hook Architecture & Content Batching",
        lessons: [
          { id: "sm_l4", title: "4. The 3-Second Hook: Copywriting & Visual Triggers", duration: "20 min", completed: false, type: "video" },
          { id: "sm_l5", title: "5. Carousel Frameworks, Reels & Short-Form Scripting", duration: "18 min", completed: false, type: "video" },
          { id: "sm_l6", title: "6. Practical Assignment: 30-Day Growth Content Matrix", duration: "30 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "sm_m3",
        title: "Module 03 - Community Funnels & Analytics Growth",
        lessons: [
          { id: "sm_l7", title: "7. Conversion Funnels, Bio Optimization & Meta Ads", duration: "22 min", completed: false, type: "video" },
          { id: "sm_l8", title: "8. Social Media Strategy & Growth Assessment", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Learn how to build, nurture, and monetize an engaged social media following organically and through paid amplification. Discover audience retention psychology, high-converting hooks, and analytics-driven content refinement.",
      objectives: [
        "Formulate content pillars that balance education, authority, entertainment, and sales",
        "Script short-form video hooks that arrest scrolling within the first 3 seconds",
        "Analyze engagement ratios and retention curves to optimize posting schedules",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 30-Day Content Calendar & 3 Hook Scripts",
      description: "Develop a 30-day content calendar for a specific business or personal brand. Define 4 content pillars, outline 12 specific post concepts with hooks, and write full scripts for 3 short-form videos (Reel/TikTok/Short) complete with visual callouts. Paste your document or Notion link below.",
      placeholder: "Share your Notion, Google Doc, or Sheets link containing your content matrix...",
    },
    quizQuestions: [
      {
        question: "Which metric is the single most critical factor for short-form video (Reels/TikTok) algorithm distribution?",
        options: [
          "The number of hashtags in the caption",
          "Watch time completion rate and replay percentage",
          "The resolution of the creator's profile picture",
          "Posting exactly at 12:00 AM midnight",
        ],
        correctIndex: 1,
      },
      {
        question: "What is the primary objective of the 'Hook' in the first 3 seconds of a social video?",
        options: [
          "To explain your full biography and credentials",
          "To disrupt feed scrolling and establish an irresistible curiosity or value premise",
          "To recite legal disclaimers",
          "To show credits for the camera equipment used",
        ],
        correctIndex: 1,
      },
      {
        question: "How is Social Media Engagement Rate generally calculated for a post?",
        options: [
          "(Total Followers ÷ Number of Posts) × 100",
          "(Total Interactions [Likes, Comments, Shares, Saves] ÷ Total Reach or Impressions) × 100",
          "Total Account Views ÷ 365 Days",
          "Battery percentage of the user viewing the content",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Social_Media_Growth_and_Strategy_Playbook.pdf",
  },

  livestreaming: {
    modules: [
      {
        id: "live_m1",
        title: "Module 01 - Streaming Gear & Encoder Optimization",
        lessons: [
          { id: "live_l1", title: "1. Capture Cards, Mirrorless Cameras & HDMI Feeds", duration: "14 min", completed: false, type: "video" },
          { id: "live_l2", title: "2. Bitrate, Framerates (60fps vs 30fps) & Network Quality", duration: "16 min", completed: false, type: "video" },
          { id: "live_l3", title: "3. Low-Latency Audio Routing & Microphone Ducking", duration: "15 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "live_m2",
        title: "Module 02 - OBS Studio Masterclass & Overlays",
        lessons: [
          { id: "live_l4", title: "4. Configuring Scenes, Sources, Window Captures & Green Screens", duration: "22 min", completed: false, type: "video" },
          { id: "live_l5", title: "5. Stream Overlays, Lower Thirds & Stream Deck Hotkeys", duration: "20 min", completed: false, type: "video" },
          { id: "live_l6", title: "6. Practical Assignment: Multi-Scene Live Broadcast Test", duration: "35 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "live_m3",
        title: "Module 03 - Multi-Platform Distribution & Moderation",
        lessons: [
          { id: "live_l7", title: "7. Restreaming to YouTube, Twitch & Interactive Chat", duration: "18 min", completed: false, type: "video" },
          { id: "live_l8", title: "8. Live Streaming Technical Engineering Assessment", duration: "25 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Learn how to produce flawless, broadcast-quality live events and interactive streams. Master OBS Studio, hardware encoding, multi-camera switching, audio sync calibration, and interactive viewer engagement tools.",
      objectives: [
        "Configure OBS video and audio output settings to match internet upload bandwidth",
        "Build a professional 4-scene live layout (Intro, Main Camera, Screen Share, Ending)",
        "Eliminate camera-audio latency mismatches with millisecond audio offset tuning",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: Multi-Scene Live Stream Test",
      description: "Configure OBS Studio with at least 3 scenes (e.g., Starting Soon, Camera Fullscreen, Screen + PiP webcam). Record or unlist-stream a 3-minute broadcast switching smoothly between scenes with clear, unclipped audio and custom overlays. Submit your stream recording link below.",
      placeholder: "Paste your unlisted YouTube, Twitch VOD, or Drive link for your broadcast recording...",
    },
    quizQuestions: [
      {
        question: "For a smooth 1080p 60fps livestream, what is the recommended video bitrate range in OBS?",
        options: [
          "500 to 1,000 Kbps",
          "6,000 to 8,000 Kbps (with sufficient upload speed)",
          "50,000 to 100,000 Kbps",
          "100 Kbps",
        ],
        correctIndex: 1,
      },
      {
        question: "If your webcam video feed lags 150 milliseconds behind your microphone voice, how do you resolve it?",
        options: [
          "Add a 150ms Sync Offset (delay) to the microphone audio in Advanced Audio Properties",
          "Lower your internet speed",
          "Unplug the webcam and rely on audio only",
          "Increase the screen brightness",
        ],
        correctIndex: 0,
      },
      {
        question: "Which hardware encoder reduces CPU load by utilizing dedicated GPU video rendering cores?",
        options: [
          "x264 (Software CPU)",
          "NVIDIA NVENC / AMD AMF Hardware Encoder",
          "VGA analog renderer",
          "Standard Windows Notepad driver",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Live_Streaming_and_Broadcast_Engineering.pdf",
  },

  broadcasting: {
    modules: [
      {
        id: "broad_m1",
        title: "Module 01 - Voice Modulation & On-Camera Articulation",
        lessons: [
          { id: "broad_l1", title: "1. Diaphragmatic Breath Control & Resonant Delivery", duration: "15 min", completed: false, type: "video" },
          { id: "broad_l2", title: "2. Eye Line, Posture & Teleprompter Reading Cadence", duration: "18 min", completed: false, type: "video" },
          { id: "broad_l3", title: "3. Media Law, Libel, Defamation & Journalistic Integrity", duration: "20 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "broad_m2",
        title: "Module 02 - Live Segment Writing & Studio Moderation",
        lessons: [
          { id: "broad_l4", title: "4. Writing for the Ear: Broadcast News Scripts & Rundowns", duration: "20 min", completed: false, type: "video" },
          { id: "broad_l5", title: "5. Conducting High-Impact In-Studio & Remote Interviews", duration: "18 min", completed: false, type: "video" },
          { id: "broad_l6", title: "6. Practical Assignment: Present a 2-Minute Broadcast Anchor Segment", duration: "30 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "broad_m3",
        title: "Module 03 - Breaking News & Live Control Room Dynamics",
        lessons: [
          { id: "broad_l7", title: "7. Handling Breaking News & In-Ear Monitor (IFB) Cues", duration: "22 min", completed: false, type: "video" },
          { id: "broad_l8", title: "8. Professional Media Broadcasting Certification Assessment", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Step into the spotlight as an articulate broadcast journalist and television presenter. Learn vocal control, confident teleprompter delivery, scriptwriting tailored for audio-visual media, and high-pressure breaking news moderation.",
      objectives: [
        "Control vocal timbre, breathing rhythm, and clarity during continuous broadcast speaking",
        "Write broadcast news stories using the inverted pyramid and conversational phrasing",
        "Maintain composed anchor presence when reacting to producer cues through IFB earpieces",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: 2-Minute Broadcast News Delivery",
      description: "Write a 2-minute news anchor script covering a real or simulated current event. Record yourself presenting straight to camera with steady eye contact, professional pacing, and vocal projection. Upload your video to Google Drive, YouTube unlisted, or Vimeo and submit the URL below.",
      placeholder: "Paste your video recording URL along with your news story script...",
    },
    quizQuestions: [
      {
        question: "Why should broadcast news scripts use conversational, short sentences instead of complex literary prose?",
        options: [
          "Because teleprompter screens can only display five words per minute",
          "Because broadcast copy is written for the ear, requiring clarity and immediate comprehension for listeners",
          "Because journalists are not allowed to use verbs",
          "To fit within Twitter character limits",
        ],
        correctIndex: 1,
      },
      {
        question: "In television news production, what is an 'IFB' (Interruptible Foldback)?",
        options: [
          "An audio earpiece that allows directors and producers to speak directly to on-air talent",
          "The main camera lens glass element",
          "The commercial break timer graphic on screen",
          "A type of stage lighting filter",
        ],
        correctIndex: 0,
      },
      {
        question: "What are the essential '5 Ws and H' of news reporting that every story must clarify?",
        options: [
          "Who, What, Where, When, Why, and How",
          "Width, Weight, Wonder, Wish, Warning, and Height",
          "Words, Websites, Windows, Weather, Writers, and Hosts",
          "None of the above",
        ],
        correctIndex: 0,
      },
    ],
    notesFileName: "Professional_Broadcast_Presenting_Mastery.pdf",
  },

  "project-management": {
    modules: [
      {
        id: "pm_m1",
        title: "Module 01 - Agile Foundations & The Scrum Framework",
        lessons: [
          { id: "pm_l1", title: "1. Agile Manifesto Values vs Traditional Waterfall", duration: "16 min", completed: false, type: "video" },
          { id: "pm_l2", title: "2. Scrum Roles: Product Owner, Scrum Master & Developers", duration: "18 min", completed: false, type: "video" },
          { id: "pm_l3", title: "3. Writing High-Quality Epics, User Stories & Acceptance Criteria", duration: "20 min", completed: false, type: "reading" },
        ],
      },
      {
        id: "pm_m2",
        title: "Module 02 - Sprint Cycles, Kanban & Backlogs",
        lessons: [
          { id: "pm_l4", title: "4. Story Point Estimation & Planning Poker", duration: "18 min", completed: false, type: "video" },
          { id: "pm_l5", title: "5. Kanban Flow: Work-in-Progress (WIP) Limits & Bottlenecks", duration: "16 min", completed: false, type: "video" },
          { id: "pm_l6", title: "6. Practical Assignment: Build an Agile Sprint Backlog Board", duration: "35 min", completed: false, type: "assignment" },
        ],
      },
      {
        id: "pm_m3",
        title: "Module 03 - Velocity, Risk & Stakeholder Communication",
        lessons: [
          { id: "pm_l7", title: "7. Burn-Down Charts, Velocity Tracking & Risk Registers", duration: "20 min", completed: false, type: "video" },
          { id: "pm_l8", title: "8. Applied Agile Project Management Certification Assessment", duration: "30 min", completed: false, type: "test" },
        ],
      },
    ],
    overview: {
      description: "Lead software, media, and business projects to on-time delivery with Agile and Scrum methodologies. Master sprint planning, backlog refinement, cross-functional team coordination, and stakeholder reporting.",
      objectives: [
        "Translate customer requirements into user stories using the 'As a... I want to... So that...' pattern",
        "Facilitate Daily Standups, Sprint Planning, Reviews, and Retrospectives",
        "Evaluate team delivery velocity and foresee delivery risks using burn-down metrics",
      ],
    },
    assignment: {
      title: "📝 Practical Assignment: Agile Sprint Board & User Stories",
      description: "Set up a sprint board (Trello, Jira, Notion, or Asana) for a new project release. Create at least 5 user stories complete with: (1) User role premise, (2) Detailed Acceptance Criteria (Given/When/Then), and (3) Story Point estimates. Share your public board link or submit your markdown document below.",
      placeholder: "Paste your Trello/Jira/Notion board share link or paste your 5 formatted user stories...",
    },
    quizQuestions: [
      {
        question: "In the Scrum framework, who is solely accountable for maximizing the value of the product and managing the Product Backlog?",
        options: [
          "The Scrum Master",
          "The Product Owner",
          "The Senior Software Developer",
          "The Project Sponsor",
        ],
        correctIndex: 1,
      },
      {
        question: "What is the primary objective of establishing Work-in-Progress (WIP) limits on a Kanban board?",
        options: [
          "To stop team members from collaborating on tasks",
          "To prevent multitasking bottlenecks and improve throughput flow by finishing tasks before starting new ones",
          "To reduce the number of employees required on a project",
          "To automatically close all open tickets at 5 PM",
        ],
        correctIndex: 1,
      },
      {
        question: "What does a typical Sprint Burn-Down Chart display?",
        options: [
          "The financial budget spent each week on office equipment",
          "The remaining estimated work (story points/hours) plotted against time remaining in the sprint",
          "The vacation days taken by individual developers",
          "The server temperature in the data center",
        ],
        correctIndex: 1,
      },
    ],
    notesFileName: "Applied_Agile_Project_Management_Handbook.pdf",
  },
};

/**
 * Helper to retrieve curriculum for a given course ID, with safe fallback to AI Essentials.
 */
export function getCurriculumForCourse(courseId) {
  return COURSE_CURRICULA[courseId] || COURSE_CURRICULA["ai-essentials"];
}
