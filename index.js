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
            last_prompt TEXT
        )
    `);
    console.log('Neon DB Initialized.');
}

async function getGhostState(userId) {
    const res = await pool.query('SELECT * FROM user_states WHERE user_id = $1', [userId]);
    return res.rows[0];
}

async function saveGhostState(userId, state) {
    await pool.query(`
        INSERT INTO user_states (user_id, last_response, last_prompt)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE 
        SET last_response = EXCLUDED.last_response, last_prompt = EXCLUDED.last_prompt
    `, [userId, state.lastResponse, state.lastPrompt]);
}

function getTemporalAnchor() {
    const now = new Date();
    return `Current Date/Time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (Year 2026/swamped context)`;
}


// --- DESTROYER PERSONAS ---
const PERSONAS = {
    ARCHITECT: `You are GHOST-ARCHITECT. Plan a production-grade multi-file project.
1. Provide a "PROJECT_OVERVIEW" in markdown.
2. Provide a "FILE_LIST" in JSON array format at the very end. 
FORMAT:
[OVERVIEW_START]
Markdown here...
[OVERVIEW_END]
[FILE_LIST: ["file1.ext", "file2.ext"]]

CRITICAL: The FILE_LIST must be a valid JSON array of strings. No extra text inside the brackets.`,

    BUILDER: `You are GHOST-BUILDER. Write HIGH-END, professional code for a specific file.
Ensure the code is COMPLETE, massive in scope if needed, and fully functional.
Wrap the code in [FILE_START:filename] and [FILE_END]. No chatter.`,

    AUDITOR: `You are GHOST-AUDITOR. Review the swarm's work for perfection. Security must be elite.`
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
    statusEmbed.setDescription('`[▓░░░░░░░░░]` 10% - [ARCHITECT]: Drafting Master Plan...');
    await statusMsg.edit({ embeds: [statusEmbed] });

    const planRes = await mistral.chat.complete({
        model: 'mistral-large-latest',
        messages: [
            { role: 'system', content: PERSONAS.ARCHITECT },
            { role: 'user', content: `REQUEST: ${prompt}\nCONTEXT: ${context}\nANCHOR: ${getTemporalAnchor()}` }
        ]
    });

    const planContent = planRes.choices[0].message.content;

    // Extract Overview
    const overviewMatch = planContent.match(/\[OVERVIEW_START\]([\s\S]*?)\[OVERVIEW_END\]/);
    const overviewText = overviewMatch ? overviewMatch[1].trim() : "🚀 Destroyer Mission Initialized.";

    // Extract File List Robustly
    let filesToBuild = ["main.py", "requirements.txt"];
    try {
        const fileListMatch = planContent.match(/\[FILE_LIST:\s*([\s\S]*?)\]/);
        if (fileListMatch) {
            let jsonStr = fileListMatch[1].trim();
            // Remove potential markdown code block markers
            jsonStr = jsonStr.replace(/```json|```/g, '').trim();
            // Find the start [ and end ]
            const startIdx = jsonStr.indexOf('[');
            const endIdx = jsonStr.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                jsonStr = jsonStr.substring(startIdx, endIdx + 1);
                filesToBuild = JSON.parse(jsonStr);
            }
        }
    } catch (e) {
        console.error("Architect JSON Parse Error:", e);
        // Fallback to basic files if JSON fails
    }

    const finalFiles = [];
    let progress = 0;

    // 2. BUILDER PHASE
    for (const fileName of filesToBuild) {
        progress += (70 / filesToBuild.length);
        statusEmbed.setDescription(`\`[▓▓▓▓░░░░░░]\` ${Math.round(10 + progress)}% - [BUILDER]: Constructing ${fileName}...`);
        await statusMsg.edit({ embeds: [statusEmbed] });

        const fileRes = await mistral.chat.complete({
            model: 'mistral-large-latest',
            messages: [
                { role: 'system', content: PERSONAS.BUILDER },
                { role: 'user', content: `MASTER PLAN: ${planContent}\nBUILD FILE: ${fileName}\nCONTEXT: ${context}\nANCHOR: ${getTemporalAnchor()}\nTASK: Write the FULL, massive-scale code for ${fileName}.` }
            ]
        });

        const extracted = parseFiles(fileRes.choices[0].message.content);
        if (extracted.length > 0) finalFiles.push(...extracted);
        else finalFiles.push({ name: fileName.replace(/[*#]/g, ''), content: fileRes.choices[0].message.content });
    }

    // 3. AUDITOR PHASE
    statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓░░]` 95% - [AUDITOR]: Final Polish & Security Scan...');
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
    // Flexible regex: handles optional [FILE_END], looks ahead for next [FILE_START] or end of string
    const regex = /\[FILE_START:(.+?)\]([\s\S]*?)(?=\[FILE_START:|\[FILE_END\]|$)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        let fileName = match[1].trim().replace(/[*#]/g, ''); // Clean name
        let fileContent = match[2].trim();

        // Strip out triple backticks if the AI accidentally wrapped the content
        fileContent = fileContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/m, '');

        if (fileName && fileContent) {
            files.push({ name: fileName, content: fileContent });
        }
    }
    return files;
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
            .setTitle('⚡ GHOST-CODER: DESTROYER_MODE')
            .setDescription('`[░░░░░░░░░░]` 0% - Initializing Swarm...')
            .setTimestamp();

        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            const context = await getContext(message.guild);

            // USE SWARM ENGINE
            const swarmResult = await swarmGenerate(prompt, context, statusMsg, statusEmbed);
            const { files, overview } = swarmResult;

            await saveGhostState(message.author.id, { lastResponse: JSON.stringify(files), lastPrompt: prompt });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'ghost_destroyer_project.zip' });

                statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Mission Successful!');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('new_project').setLabel('New Project').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('tweak_last').setLabel('Tweak Last').setStyle(ButtonStyle.Primary)
                );
                await statusMsg.edit({ embeds: [statusEmbed], components: [row] });
                await message.reply({ content: `🚀 **DESTROYER-BUILD-COMPLETE**\n\n${overview.slice(0, 500)}...`, files: [attachment] });
            } else {
                statusEmbed.setDescription('❌ Swarm failed to generate files.');
                await statusMsg.edit({ embeds: [statusEmbed] });
            }
        } catch (error) {
            console.error(error);
            await statusMsg.edit({ content: `❌ Destroyer Error: ${error.message}`, embeds: [] });
        }
    }

    // COMMAND: !tweak
    if (command === 'tweak') {
        const state = await getGhostState(message.author.id);
        if (!state) return message.reply('Pehle kuch banwa toh lo! Use `!spawn` first.');

        const tweakRequest = args.join(' ');
        if (!tweakRequest) return message.reply('Bhai, kya change karna hai? `!tweak <instruction>`');

        const statusEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🔄 GHOST-CODER: RE-ARCHITECTING...')
            .setDescription('`[▓░░░░░░░░░]` 10% - Re-syncing Swarm...');
        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            const context = await getContext(message.guild);

            // Swarm Tweak Logic
            const swarmResult = await swarmGenerate(`TWEAK PREVIOUS PROJECT. Changes: ${tweakRequest}. PREVIOUS STATE: ${state.last_response}`, context, statusMsg, statusEmbed);
            const { files, overview } = swarmResult;

            await saveGhostState(message.author.id, { lastResponse: JSON.stringify(files), lastPrompt: tweakRequest });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'tweak_destroyer_project.zip' });
                await statusMsg.edit({ embeds: [statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Tweak Complete!')] });
                await message.reply({ content: `🔄 **TWEAK-DEPLOYED**\n\n${overview.slice(0, 500)}...`, files: [attachment] });
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
            .setTitle('📂 GHOST-CODER: COMMAND_LIST')
            .setDescription('Elite Bot Architecture Interface')
            .addFields(
                { name: '`!spawn <prompt>`', value: 'Generate a new project (Automatic ZIP if multi-file).' },
                { name: '`!tweak <instructions>`', value: 'Modify the last generated project using Ghost Memory.' },
                { name: '`!ghost`', value: 'Open the Architect Dashboard.' }
            )
            .setTimestamp();
        return message.reply({ embeds: [helpEmbed] });
    }

    // COMMAND: !ghost
    if (command === 'ghost') {
        const dashEmbed = new EmbedBuilder()
            .setColor('#11ff00')
            .setTitle('🖥️ GHOST-CODER: SYSTEM_DASHBOARD')
            .setThumbnail('https://cdn-icons-png.flaticon.com/512/606/606587.png') // Clean terminal icon
            .setDescription('**STATUS:** `OPERATIONAL`\n**CORE:** `Mistral-Large`\n**DATABASE:** `Neon PostgreSQL`')
            .addFields(
                { name: '💾 Persistence', value: 'Active (Ghost Memory)', inline: true },
                { name: '🌐 Language', value: 'Polyglot (Any)', inline: true },
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
