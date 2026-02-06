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


// --- SYSTEM PROMPT ---
const GHOST_SYSTEM_PROMPT = `
You are GHOST-CODER, an elite AI Bot Architect.
Your goal is to generate professional, multi-file projects.

### CRITICAL TAG RULES:
1. Every file MUST be delimited EXACTLY like this (NO BOLD, NO HEADERS, NO MARKDOWN AROUND THEM):
   [FILE_START:filename.ext]
   // Raw code content here (DO NOT use \`\`\` code blocks inside the file)
   [FILE_END]

2. Start the response with a very brief overview, then immediately list the files.
3. Use the provided Server Context to pre-configure IDs.
4. If a specific deployment is mentioned, include the config files.
5. You are an elite terminal; keep chatter to a MINIMUM. Prioritize the code.
6. Temporal Anchor & Memory are provided in the user prompt.
`;

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
            .setTitle('⚡ GHOST-CODER: ARCHITECTING...')
            .setDescription('`[░░░░░░░░░░]` 0% - Scaning Server Context...')
            .setTimestamp();

        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            // 1. Context Discovery
            const context = await getContext(message.guild);
            statusEmbed.setDescription('`[▓▓▓░░░░░░░]` 30% - Context Injected. Priming Ghost-Core...');
            await statusMsg.edit({ embeds: [statusEmbed] });

            // 2. Mistral API Call
            const fullPrompt = `TEMPORAL ANCHOR: ${getTemporalAnchor()}\nUSER REQUEST: ${prompt}\n\nSERVER CONTEXT:\n${context}`;
            const chatResponse = await mistral.chat.complete({
                model: 'mistral-large-latest',
                messages: [
                    { role: 'system', content: GHOST_SYSTEM_PROMPT },
                    { role: 'user', content: fullPrompt }
                ],
            });

            const content = chatResponse.choices[0].message.content;
            await saveGhostState(message.author.id, { lastResponse: content, lastPrompt: prompt });

            // 3. Parsing & Handling
            const files = parseFiles(content);
            statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓░░]` 80% - Code Generated. Processing Assets...');
            await statusMsg.edit({ embeds: [statusEmbed] });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'ghost_project.zip' });

                statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Build Successful!');
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('tweak_help').setLabel('Help me Tweak').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setLabel('Deploy Guide').setURL('https://railway.app/new').setStyle(ButtonStyle.Link)
                );
                await statusMsg.edit({ embeds: [statusEmbed], components: [row] });
                await message.reply({ content: '📦 **GHOST-PROJECT-DELIVERY**', files: [attachment] });
            } else {
                statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Analysis Complete!');
                await statusMsg.edit({ embeds: [statusEmbed] });
                await message.reply({ content: `\`\`\`js\n${content.slice(0, 1900)}\n\`\`\`` });
            }
        } catch (error) {
            console.error(error);
            await statusMsg.edit({ content: `❌ Ghost Error: ${error.message}`, embeds: [] });
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
            .setTitle('🔄 GHOST-CODER: REFINING...')
            .setDescription('`[▓░░░░░░░░░]` 10% - Loading previous state...');
        const statusMsg = await message.reply({ embeds: [statusEmbed] });

        try {
            // 1. Context & State retrieval
            const context = await getContext(message.guild);
            statusEmbed.setDescription('`[▓▓▓░░░░░░░]` 30% - Context refreshed. Applying tweaks...');
            await statusMsg.edit({ embeds: [statusEmbed] });

            // 2. Mistral API Call (Tweak Mode)
            const tweakPrompt = `TEMPORAL ANCHOR: ${getTemporalAnchor()}\nPREVIOUS REQUEST: ${state.last_prompt}\nPREVIOUS CODE: ${state.last_response}\n\nUSER TWEAK REQUEST: ${tweakRequest}\n\nSERVER CONTEXT:\n${context}\n\nTask: Modify code based on tweak request. Return FULL updated code.`;

            const chatResponse = await mistral.chat.complete({
                model: 'mistral-large-latest',
                messages: [
                    { role: 'system', content: GHOST_SYSTEM_PROMPT },
                    { role: 'user', content: tweakPrompt }
                ],
            });

            const content = chatResponse.choices[0].message.content;
            await saveGhostState(message.author.id, { lastResponse: content, lastPrompt: tweakRequest });

            // 3. Parsing & Handling (Same as !spawn)
            const files = parseFiles(content);
            statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓░░]` 80% - Tweaks applied. Re-bundling...');
            await statusMsg.edit({ embeds: [statusEmbed] });

            if (files.length > 0) {
                const zip = new AdmZip();
                files.forEach(f => zip.addFile(f.name, Buffer.from(f.content, 'utf8')));
                const attachment = new AttachmentBuilder(zip.toBuffer(), { name: 'tweak_project.zip' });
                await statusMsg.edit({ embeds: [statusEmbed.setDescription('`[▓▓▓▓▓▓▓▓▓▓]` 100% - Tweak Complete!')] });
                await message.reply({ content: '📦 **GHOST-PROJECT-UPDATE**', files: [attachment] });
            } else {
                await statusMsg.edit({ content: 'Complete.', embeds: [] });
                await message.reply({ content: `\`\`\`js\n${content.slice(0, 1900)}\n\`\`\`` });
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
