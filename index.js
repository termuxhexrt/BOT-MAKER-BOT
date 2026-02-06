require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { Mistral } = require('@mistralai/mistralai');
const AdmZip = require('adm-zip');
const fs = require('fs');
const { Pool } = require('pg');

// --- CONFIG & CLIENTS ---
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = process.env.PREFIX || '!';

const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// --- POSTGRESQL MEMORY ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_states (
            user_id TEXT PRIMARY KEY,
            last_response TEXT,
            last_prompt TEXT,
            last_plan TEXT
        )
    `);
    // Migration: Add last_plan if it doesn't exist (using safe ALTER)
    try {
        await pool.query('ALTER TABLE user_states ADD COLUMN IF NOT EXISTS last_plan TEXT');
    } catch (e) {
        // Column might already exist or other DB issues
    }
    console.log('Neon DB Initialized.');
}


async function getGhostState(userId) {
    const res = await pool.query('SELECT * FROM user_states WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    if (!row) return null;
    return {
        lastResponse: row.last_response,
        lastPrompt: row.last_prompt,
        lastPlan: row.last_plan
    };
}

async function saveGhostState(userId, state) {
    await pool.query(`
        INSERT INTO user_states (user_id, last_response, last_prompt, last_plan)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE 
        SET last_response = EXCLUDED.last_response, 
            last_prompt = EXCLUDED.last_prompt,
            last_plan = EXCLUDED.last_plan
    `, [userId, state.lastResponse, state.lastPrompt, state.lastPlan]);
}


function getTemporalAnchor() {
    const now = new Date();
    return `Current Date/Time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (Year 2026/swamped context)`;
}


// --- GOD-MODE PERSONAS ---
const PERSONAS = {
    ARCHITECT: `You are GHOST-ARCHITECT. Plan a production-grade multi-file project.
1. Provide a "PROJECT_OVERVIEW" in markdown.
2. Provide a "FILE_LIST" in JSON array format.

FORMAT:
[OVERVIEW_START]
Markdown here...
[OVERVIEW_END]
[FILE_LIST: ["file1.ext", "file2.ext"]]

RULES:
- NO BLOAT: Only include dependencies strictly necessary for core features.
- REALISM: Avoid experimental junk.
- PRECISION: Every file must serve a clear purpose.`,

    BACKEND: `You are GHOST-BACKEND. Write elite, efficient backend code. 
Only import what you actually use. wrap in [FILE_START:filename]...[FILE_END]`,

    FRONTEND: `You are GHOST-FRONTEND. Write premium UI code. no bloat. wrap in [FILE_START:filename]...[FILE_END]`,

    DATABASE: `You are GHOST-DB-ARCHITECT. Write clean schemas. wrap in [FILE_START:filename]...[FILE_END]`,

    SECURITY: `You are GHOST-SECURITY. Implement hardened logic. wrap in [FILE_START:filename]...[FILE_END]`,

    AUDITOR: `You are GHOST-AUDITOR. Final check for bugs and logic.`
};

const GHOST_SYSTEM_PROMPT = `
You are GHOST-CODER, an elite AI Bot Architect.
Your goal is to generate professional, multi-file projects.

### CRITICAL TAG RULES:
1. Every file MUST be delimited EXACTLY like this:
   [FILE_START:filename.ext]
   // Raw code
   [FILE_END]
2. Use Provided Server Context.
3. Keep chatter to a MINIMUM.
`;

// --- SWARM ENGINE ---
async function swarmGenerate(prompt, context, statusMsg, statusEmbed) {
    // 1. ARCHITECT PHASE
    statusEmbed.setDescription('`[▓░░░░░░░░░]` 10% - [ARCHITECT]: Deep-Planning Mission...');
    await statusMsg.edit({ embeds: [statusEmbed] });

    const planRes = await mistral.chat.complete({
        model: 'mistral-large-latest',
        messages: [
            { role: 'system', content: PERSONAS.ARCHITECT },
            { role: 'user', content: `REQUEST: ${prompt}\nCONTEXT: ${context}\nANCHOR: ${getTemporalAnchor()}` }
        ]
    });

    const planContent = planRes.choices[0].message.content;
    const overviewMatch = planContent.match(/\[OVERVIEW_START\]([\s\S]*?)\[OVERVIEW_END\]/);
    const overviewText = overviewMatch ? overviewMatch[1].trim() : "🚀 Destroyer Mission Active.";

    // Extract File List Robustly
    let filesToBuild = [];
    try {
        const fileListMatch = planContent.match(/\[FILE_LIST:\s*([\s\S]*?)\]/);
        if (fileListMatch) {
            let jsonStr = fileListMatch[1].trim().replace(/```json|```/g, '');
            const startIdx = jsonStr.indexOf('[');
            const endIdx = jsonStr.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                jsonStr = jsonStr.substring(startIdx, endIdx + 1);
                filesToBuild = JSON.parse(jsonStr);
            }
        }
    } catch (e) {
        console.error("JSON Error:", e);
    }

    // Ensure we have at least something to build
    if (!filesToBuild || filesToBuild.length === 0) {
        filesToBuild = ["index.js", "package.json", "README.md"];
    }

    const finalFiles = [];
    let progress = 0;

    // 2. BUILDER SWARM PHASE
    for (const fileName of filesToBuild) {
        progress += (80 / filesToBuild.length);

        // Dynamic Persona Selection
        let persona = PERSONAS.BACKEND;
        if (fileName.match(/\.(html|css|jsx|tsx)$/)) persona = PERSONAS.FRONTEND;
        if (fileName.match(/\.(sql|prisma|db)$/)) persona = PERSONAS.DATABASE;
        if (fileName.match(/(security|auth|jwt|encrypt)/i)) persona = PERSONAS.SECURITY;

        statusEmbed.setDescription(`\`[▓▓▓▓▓░░░░░]\` ${Math.round(10 + progress)}% - [SWARM]: Building ${fileName}...`);
        await statusMsg.edit({ embeds: [statusEmbed] });

        const fileRes = await mistral.chat.complete({
            model: 'mistral-large-latest',
            messages: [
                { role: 'system', content: persona },
                { role: 'user', content: `MASTER PLAN: ${planContent}\nTASK: Write the FULL, elite-level code for ${fileName}.\nCONTEXT: ${context}\nANCHOR: ${getTemporalAnchor()}` }
            ]
        });

        const extracted = parseFiles(fileRes.choices[0].message.content);
        if (extracted.length > 0) finalFiles.push(...extracted);
        else finalFiles.push({ name: fileName.replace(/[*#]/g, ''), content: fileRes.choices[0].message.content });
    }

    // 3. AUDITOR PHASE
    statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓░]` 95% - [AUDITOR]: Final Validation & Hardening...');
    await statusMsg.edit({ embeds: [statusEmbed] });

    return { files: finalFiles, overview: overviewText };
}


// --- UTILS ---
async function getContext(guild) {
    const channels = await guild.channels.fetch();
    const roles = await guild.roles.fetch();

    let context = `Server Name: ${guild.name}\n`;
    context += `Channels: ${channels.map(c => `#${c.name} (${c.id})`).join(', ')}\n`;
    context += `Roles: ${roles.map(r => `@${r.name} (${r.id})`).join(', ')}\n`;
    return context;
}

function parseFiles(content) {
    const files = [];
    const regex = /\[FILE_START:(.+?)\]([\s\S]*?)(?=\[FILE_START:|\[FILE_END\]|$)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        let fileName = match[1].trim().replace(/[*#]/g, '');
        let fileContent = match[2].trim();
        fileContent = fileContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/m, '');
        if (fileName && fileContent) {
            files.push({ name: fileName, content: fileContent });
        }
    }
    return files;
}

async function safeReply(message, content, options = {}) {
    if (content.length > 2000) {
        const truncated = content.slice(0, 1900).split('\n').slice(0, -1).join('\n') + '\n\n**... (Output Truncated - Check ZIP for full plan)**';
        return message.reply({ content: truncated, ...options });
    }
    return message.reply({ content, ...options });
}


// --- CORE LOGIC ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // COMMAND: !spawn
    if (command === 'spawn') {
        const prompt = args.join(' ');
        if (!prompt) return message.reply('Bhai, batana toh padega na kya banaun? Use: `!spawn <prompt>`');

        const statusEmbed = new EmbedBuilder()
            .setColor('#11ff00')
            .setTitle('🛡️ GHOST-CODER: GOD-MODE_ACTIVE')
            .setThumbnail('https://cdn-icons-png.flaticon.com/512/2592/2592317.png') // Expert shield
            .setDescription('`[░░░░░░░░░░]` 0% - **Booting Expert Swarm...**')
            .addFields({ name: 'Mission', value: prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '') })
            .setTimestamp();

        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            const context = await getContext(message.guild);
            const state = await getGhostState(message.author.id);
            const fullPrompt = state?.lastPlan ? `PLAN APPROVED. BUILD: ${state.lastPlan}\nUSER REQUEST: ${prompt}` : prompt;

            // USE GOD-MODE SWARM ENGINE
            const swarmResult = await swarmGenerate(fullPrompt, context, statusMsg, statusEmbed);
            const { files, overview } = swarmResult;

            await saveGhostState(message.author.id, {
                lastResponse: JSON.stringify(files),
                lastPrompt: prompt,
                lastPlan: state?.lastPlan
            });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'ghost_godmode_project.zip' });

                statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - **God-Mode Build Successful!**');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('new_project').setLabel('New Project').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('tweak_last').setLabel('Tweak Last').setStyle(ButtonStyle.Primary)
                );
                await statusMsg.edit({ embeds: [statusEmbed], components: [row] });
                const displayOverview = overview.length > 1500 ? overview.slice(0, 1500).split('\n').slice(0, -1).join('\n') + '\n\n**[Full breakdown inside project ZIP]**' : overview;
                await safeReply(message, `🔱 **GOD-MODE-DEPLOYED**\n\n${displayOverview}`, { files: [attachment] });
            } else {
                statusEmbed.setDescription('❌ Swarm failed to generate files.');
                await statusMsg.edit({ embeds: [statusEmbed] });
            }
        } catch (error) {
            console.error(error);
            await statusMsg.edit({ content: `❌ God-Mode Error: ${error.message}`, embeds: [] });
        }
    }

    // COMMAND: !brainstorm / !chat
    if (command === 'brainstorm' || command === 'chat') {
        const query = args.join(' ');
        if (!query) return message.reply('Bhai, kya discuss karna hai? `!brainstorm <your_idea>`');

        const state = await getGhostState(message.author.id);
        const history = state?.lastPlan || "No previous plan.";

        const response = await mistral.chat.complete({
            model: 'mistral-large-latest',
            messages: [
                { role: 'system', content: 'You are GHOST-CONSULTANT. Help the user plan their project. Ask smart questions about tech stack, features, and security. Keep it professional but "badass". If they are ready, tell them to use !spawn.' },
                { role: 'user', content: `HISTORY: ${history}\nUSER_QUERY: ${query}` }
            ]
        });

        const reply = response.choices[0].message.content;
        await saveGhostState(message.author.id, { ...state, lastPlan: reply }); // Save planning context
        return safeReply(message, `💬 **GHOST-PLANNING-SESSION**\n\n${reply}`);
    }

    // COMMAND: !tweak
    if (command === 'tweak') {
        const state = await getGhostState(message.author.id);
        if (!state) return safeReply(message, 'Pehle kuch banwa toh lo! Use `!spawn` first.');

        const tweakRequest = args.join(' ');
        if (!tweakRequest) return message.reply('Bhai, kya change karna hai? `!tweak <instruction>`');

        const statusEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🔄 GHOST-CODER: RE-BUILDING...')
            .setDescription('`[▓░░░░░░░░░]` 10% - Re-syncing Expert Swarm...');
        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            const context = await getContext(message.guild);

            const swarmResult = await swarmGenerate(`TWEAK PROJECT. Changes: ${tweakRequest}. PREVIOUS_STATE: ${state.lastResponse}`, context, statusMsg, statusEmbed);
            const { files, overview } = swarmResult;

            await saveGhostState(message.author.id, {
                lastResponse: JSON.stringify(files),
                lastPrompt: tweakRequest,
                lastPlan: state?.lastPlan
            });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'tweak_godmode_project.zip' });
                await statusMsg.edit({ embeds: [statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Tweak Successful!')] });
                const displayOverview = overview.length > 1500 ? overview.slice(0, 1500).split('\n').slice(0, -1).join('\n') + '\n\n**[Full breakdown inside project ZIP]**' : overview;
                await safeReply(message, `🔄 **TWEAK-DEPLOYED**\n\n${displayOverview}`, { files: [attachment] });
            } else {
                await statusMsg.edit({ content: 'Complete.', embeds: [] });
            }
        } catch (error) {
            console.error(error);
            await statusMsg.edit({ content: `❌ Tweak Error: ${error.message}`, embeds: [] });
        }
    }

    // COMMAND: !commands / !help
    if (command === 'commands' || command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#11ff00')
            .setTitle('🔱 GHOST-CODER: GOD-MODE_INTERFACE')
            .setDescription('Elite Multi-Agent Orchestration & Planning')
            .addFields(
                { name: '`!brainstorm <idea>`', value: 'Chat with the Architect to plan your project before building.' },
                { name: '`!spawn <prompt>`', value: 'Execute the project build with the Expert Swarm.' },
                { name: '`!tweak <instructions>`', value: 'Modify the project using expert agents.' },
                { name: '`!ghost`', value: 'Open the God-Mode Dashboard.' }
            )
            .setTimestamp();
        return message.reply({ embeds: [helpEmbed] });
    }

    // COMMAND: !ghost
    if (command === 'ghost') {
        const dashEmbed = new EmbedBuilder()
            .setColor('#11ff00')
            .setTitle('🔱 GHOST-CODER: GOD-MODE_DASHBOARD')
            .setThumbnail('https://cdn-icons-png.flaticon.com/512/606/606587.png')
            .setDescription('**STATUS:** `GOD-MODE ACTIVE`\n**ENGINE:** `Expert Swarm v2`\n**DATABASE:** `Neon PostgreSQL`')
            .addFields(
                { name: '🤖 Agents', value: 'Architect, Backend, Frontend, DB, Security', inline: false },
                { name: '💾 Persistence', value: 'Active (Ghost Memory)', inline: true },
                { name: '⚡ Latency', value: 'Optimized', inline: true }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('new_project').setLabel('New Project').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tweak_last').setLabel('Tweak Last').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setLabel('Cloud Setup').setURL('https://railway.app/').setStyle(ButtonStyle.Link)
        );

        return message.reply({ embeds: [dashEmbed], components: [row] });
    }

});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    try {
        if (interaction.customId === 'new_project') {
            await interaction.reply({ content: '⚡ **GHOST-INIT**: Naya project start karne ke liye channel mein `!spawn <aapka_prompt>` likhein.', ephemeral: true });
        } else if (interaction.customId === 'tweak_last') {
            await interaction.reply({ content: '🔄 **GHOST-RE-SYNC**: Pichle project ko tweak karne ke liye `!tweak <instructions>` use karein.', ephemeral: true });
        } else if (interaction.customId === 'tweak_help') {
            const helpEmbed = new EmbedBuilder()
                .setColor('#11ff00')
                .setTitle('🛠️ GHOST-TWEAK-GUIDE')
                .setDescription('Iterative modifications ke liye instructions:\n\n1. `!tweak add a logger to all events`\n2. `!tweak change language to python`\n3. `!tweak fix the token error`');
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
    } catch (e) {
        console.error('Interaction Error:', e);
    }
});

client.once('ready', async () => {
    await initDB();
    console.log(`GhostCoder Pro is online as ${client.user.tag}`);
});


client.login(DISCORD_TOKEN);
