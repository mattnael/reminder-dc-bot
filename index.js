require('dotenv').config();
const path = require('path');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

// Setup Path Database (Mendukung Volume Railway)
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbDir = volumePath || __dirname;
const dbPath = path.join(dbDir, 'reminders_bot.db');

// Inisialisasi Database SQLite
const db = new Database(dbPath);

// Setup Schema Database
db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        title TEXT,
        target_timestamp INTEGER,
        timezone_name TEXT,
        original_time_str TEXT,
        mention_type TEXT DEFAULT 'user', -- 'user' atau 'here'
        reminded_1d INTEGER DEFAULT 0,
        reminded_2h INTEGER DEFAULT 0,
        reminded_0m INTEGER DEFAULT 0,
        is_completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Auto-Migration jika table lama belum punya kolom mention_type
try { 
    db.exec("ALTER TABLE reminders ADD COLUMN mention_type TEXT DEFAULT 'user';"); 
} catch (e) {}

// Inisialisasi Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
    allowedMentions: {
        parse: ['everyone', 'roles', 'users']
    }
});

// Daftar Zona Waktu yang Didukung
const TIMEZONE_MAP = {
    'WIB': 'Asia/Jakarta',      // UTC+7
    'WITA': 'Asia/Makassar',    // UTC+8
    'WIT': 'Asia/Jayapura',     // UTC+9
    'UTC': 'UTC'
};

// Mendaftarkan Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Buat jadwal pengingat baru (Notifikasi H-1 Hari, H-2 Jam, dan Hari H)')
        .addStringOption(opt =>
            opt.setName('title')
               .setDescription('Nama acara / jadwal (Contoh: Rapat Komunitas / Raid DDN)')
               .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('datetime')
               .setDescription('Tanggal & Jam (Contoh: "25 August 2026 11:00 AM" atau "2026-08-25 11:00")')
               .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('timezone')
               .setDescription('Pilih zona waktu')
               .setRequired(true)
               .addChoices(
                   { name: 'WIB (Waktu Indonesia Barat - UTC+7)', value: 'WIB' },
                   { name: 'WITA (Waktu Indonesia Tengah - UTC+8)', value: 'WITA' },
                   { name: 'WIT (Waktu Indonesia Timur - UTC+9)', value: 'WIT' },
                   { name: 'UTC', value: 'UTC' }
               )
        )
        .addStringOption(opt =>
            opt.setName('target')
               .setDescription('Siapa yang ingin di-tag saat pengingat berbunyi? (Default: Diri Sendiri)')
               .setRequired(false)
               .addChoices(
                   { name: '👤 Diri Sendiri (Tag Pembuat)', value: 'user' },
                   { name: '📢 Seluruh Server (Tag @here)', value: 'here' }
               )
        )
        .addChannelOption(opt =>
            opt.setName('channel')
               .setDescription('Channel tujuan notifikasi (Opsional, default: channel saat ini)')
               .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('list-reminders')
        .setDescription('Lihat semua jadwal pengingat yang sedang aktif di server ini'),
    new SlashCommandBuilder()
        .setName('cancel-reminder')
        .setDescription('Batalkan jadwal pengingat berdasarkan ID')
        .addIntegerOption(opt =>
            opt.setName('id')
               .setDescription('ID Pengingat (lihat dari /list-reminders)')
               .setRequired(true)
        )
].map(cmd => cmd.toJSON());

// Helper Parser Waktu Fleksibel
function parseFlexibleDateTime(dateStr, tzKey) {
    const tz = TIMEZONE_MAP[tzKey] || 'Asia/Jakarta';
    const cleanStr = dateStr.trim();

    const formats = [
        'd MMMM yyyy h:mm a',
        'd MMMM yyyy hh:mm a',
        'd MMMM yyyy HH:mm',
        'yyyy-MM-dd HH:mm',
        'yyyy-MM-dd h:mm a',
        'dd-MM-yyyy HH:mm',
        'dd/MM/yyyy HH:mm',
        'd MMM yyyy HH:mm',
        'd MMM yyyy h:mm a'
    ];

    for (const fmt of formats) {
        const dt = DateTime.fromFormat(cleanStr, fmt, { zone: tz, locale: 'en' });
        if (dt.isValid) return dt;
    }

    const currentYear = DateTime.now().setZone(tz).year;
    for (const fmt of ['d MMMM h:mm a', 'd MMMM HH:mm', 'd MMM h:mm a', 'd MMM HH:mm']) {
        const dt = DateTime.fromFormat(`${cleanStr} ${currentYear}`, `${fmt} yyyy`, { zone: tz, locale: 'en' });
        if (dt.isValid) return dt;
    }

    const dtIso = DateTime.fromISO(cleanStr, { zone: tz });
    if (dtIso.isValid) return dtIso;

    return null;
}

// Register Slash Commands saat Bot Siap
client.once('clientReady', async () => {
    console.log(`🤖 Reminder Bot Online sebagai ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash Commands Reminder Berhasil Didaftarkan!');
    } catch (error) {
        console.error('❌ Gagal mendaftarkan slash command:', error);
    }

    // Jalankan background worker pemeriksa reminder tiap 30 detik
    setInterval(checkAndSendReminders, 30 * 1000);
});

// ==========================================
// BACKGROUND REMINDER WORKER (3 TAHAP)
// ==========================================
async function checkAndSendReminders() {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const activeReminders = db.prepare('SELECT * FROM reminders WHERE is_completed = 0').all();

    for (const rem of activeReminders) {
        const target = rem.target_timestamp;
        const timeLeft = target - now;

        try {
            const channel = await client.channels.fetch(rem.channel_id).catch(() => null);
            if (!channel) continue;

            const isServerReminder = rem.mention_type === 'here';
            const mentionText = isServerReminder ? '@here' : `<@${rem.user_id}>`;

            // 1. TAHAP 1: H-1 Hari (24 Jam)
            if (timeLeft <= oneDayMs && timeLeft > twoHoursMs && rem.reminded_1d === 0) {
                db.prepare('UPDATE reminders SET reminded_1d = 1 WHERE id = ?').run(rem.id);

                const embed1d = new EmbedBuilder()
                    .setTitle('📢 Pengingat Jadwal: H-1 Hari!')
                    .setColor(0xFFA500)
                    .setDescription(`Halo ${mentionText}, jadwal **${rem.title}** akan berlangsung dalam **1 hari lagi**!`)
                    .addFields(
                        { name: '⏰ Waktu Acara', value: `<t:${Math.floor(target / 1000)}:F> (<t:${Math.floor(target / 1000)}:R>)`, inline: false },
                        { name: '🌐 Zona Waktu', value: `${rem.timezone_name}`, inline: true }
                    )
                    .setFooter({ text: `Reminder ID: ${rem.id} • Dibuat oleh Host` })
                    .setTimestamp();

                await channel.send({ 
                    content: mentionText, 
                    embeds: [embed1d],
                    allowedMentions: { parse: ['everyone', 'users'] }
                });
            }

            // 2. TAHAP 2: H-2 Jam
            if (timeLeft <= twoHoursMs && timeLeft > 0 && rem.reminded_2h === 0) {
                db.prepare('UPDATE reminders SET reminded_2h = 1 WHERE id = ?').run(rem.id);

                const embed2h = new EmbedBuilder()
                    .setTitle('⏰ Pengingat Jadwal: H-2 Jam!')
                    .setColor(0xFF4500)
                    .setDescription(`Halo ${mentionText}, bersiap-siap! Jadwal **${rem.title}** akan dimulai dalam **2 jam lagi**!`)
                    .addFields(
                        { name: '⏰ Waktu Acara', value: `<t:${Math.floor(target / 1000)}:F> (<t:${Math.floor(target / 1000)}:R>)`, inline: false }
                    )
                    .setFooter({ text: `Reminder ID: ${rem.id}` })
                    .setTimestamp();

                await channel.send({ 
                    content: mentionText, 
                    embeds: [embed2h],
                    allowedMentions: { parse: ['everyone', 'users'] }
                });
            }

            // 3. TAHAP 3: HARI H (On-Time Saat Waktu Tiba)
            if (timeLeft <= 0 && rem.reminded_0m === 0) {
                db.prepare('UPDATE reminders SET reminded_0m = 1, is_completed = 1 WHERE id = ?').run(rem.id);

                const embed0m = new EmbedBuilder()
                    .setTitle('🔔 WAKTU JADWAL TELAH TIBA!')
                    .setColor(0x00FF00)
                    .setDescription(`🔔 ${mentionText}, waktu untuk jadwal **${rem.title}** sudah tiba sekarang!`)
                    .addFields(
                        { name: '📋 Acara', value: `${rem.title}`, inline: true },
                        { name: '⏰ Waktu Target', value: `<t:${Math.floor(target / 1000)}:F>`, inline: true }
                    )
                    .setFooter({ text: `Reminder ID: ${rem.id} • Selesai` })
                    .setTimestamp();

                await channel.send({ 
                    content: `🔔 ${mentionText} **Waktunya ${rem.title}!**`, 
                    embeds: [embed0m],
                    allowedMentions: { parse: ['everyone', 'users'] }
                });
            }

        } catch (err) {
            console.error(`Gagal mengirim reminder ID ${rem.id}:`, err);
        }
    }
}

// ==========================================
// INTERACTION COMMAND HANDLER
// ==========================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // --- 1. COMMAND: /remind ---
    if (interaction.commandName === 'remind') {
        const title = interaction.options.getString('title');
        const rawDateTime = interaction.options.getString('datetime');
        const tzKey = interaction.options.getString('timezone');
        const targetType = interaction.options.getString('target') || 'user';
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

        const parsedDate = parseFlexibleDateTime(rawDateTime, tzKey);

        if (!parsedDate) {
            return interaction.reply({
                content: `❌ Format tanggal/jam **"${rawDateTime}"** tidak dikenali!\n\n💡 **Contoh format yang benar:**\n• \`25 August 2026 11:00 AM\`\n• \`25 August 11:00 AM\`\n• \`2026-08-25 14:30\`\n• \`25-08-2026 14:30\``,
                flags: MessageFlags.Ephemeral
            });
        }

        const targetTimestamp = parsedDate.toMillis();
        const now = Date.now();

        if (targetTimestamp <= now) {
            return interaction.reply({
                content: `❌ Waktu yang kamu masukkan sudah lewat (${parsedDate.toFormat('dd MMMM yyyy, HH:mm')} ${tzKey})! Masukkan waktu di masa depan.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Simpan ke SQLite beserta mention_type
        const stmt = db.prepare(`
            INSERT INTO reminders (guild_id, channel_id, user_id, title, target_timestamp, timezone_name, original_time_str, mention_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            interaction.guildId,
            targetChannel.id,
            interaction.user.id,
            title,
            targetTimestamp,
            tzKey,
            rawDateTime,
            targetType
        );

        const unixSeconds = Math.floor(targetTimestamp / 1000);
        const targetLabel = targetType === 'here' ? '📢 Seluruh Server (`@here`)' : `👤 Pribadi (<@${interaction.user.id}>)`;

        const embedSuccess = new EmbedBuilder()
            .setTitle('✅ Pengingat Berhasil Dibuat!')
            .setColor(0x00FF7F)
            .setDescription(`Bot akan otomatis mengingatkan jadwal ini di <#${targetChannel.id}>:`)
            .addFields(
                { name: '📋 Acara / Judul', value: `**${title}**`, inline: false },
                { name: '🗓️ Waktu Acara', value: `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`, inline: false },
                { name: '🎯 Target Mention', value: targetLabel, inline: true },
                { name: '🌐 Zona Waktu', value: `${tzKey} (${TIMEZONE_MAP[tzKey]})`, inline: true },
                { name: '🔔 Tahapan Notifikasi', value: '• 📢 **H-1 Hari** (24 Jam sebelum)\n• ⏰ **H-2 Jam** sebelum\n• 🔔 **Hari-H** (Tepat waktu)', inline: false }
            )
            .setFooter({ text: `ID Pengingat: ${info.lastInsertRowid}` })
            .setTimestamp();

        return interaction.reply({ embeds: [embedSuccess] });
    }

    // --- 2. COMMAND: /list-reminders ---
    if (interaction.commandName === 'list-reminders') {
        const rows = db.prepare(`
            SELECT * FROM reminders 
            WHERE guild_id = ? AND is_completed = 0 
            ORDER BY target_timestamp ASC
        `).all(interaction.guildId);

        if (rows.length === 0) {
            return interaction.reply({
                content: '📅 Tidak ada jadwal pengingat yang aktif saat ini di server ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        let desc = '';
        rows.forEach(r => {
            const unix = Math.floor(r.target_timestamp / 1000);
            const targetTag = r.mention_type === 'here' ? '`@here` (Server)' : `<@${r.user_id}> (Pribadi)`;
            desc += `**#${r.id} | ${r.title}**\n`;
            desc += `• Waktu: <t:${unix}:F> (<t:${unix}:R>)\n`;
            desc += `• Target: ${targetTag} | Channel: <#${r.channel_id}>\n\n`;
        });

        const listEmbed = new EmbedBuilder()
            .setTitle('📋 Daftar Pengingat Aktif')
            .setColor(0x5865F2)
            .setDescription(desc)
            .setFooter({ text: 'Gunakan /cancel-reminder [id] untuk membatalkan pengingat' });

        return interaction.reply({ embeds: [listEmbed] });
    }

    // --- 3. COMMAND: /cancel-reminder ---
    if (interaction.commandName === 'cancel-reminder') {
        const reminderId = interaction.options.getInteger('id');
        const reminder = db.prepare('SELECT * FROM reminders WHERE id = ? AND guild_id = ?').get(reminderId, interaction.guildId);

        if (!reminder) {
            return interaction.reply({
                content: `❌ Jadwal pengingat dengan ID **#${reminderId}** tidak ditemukan atau sudah selesai.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const isOwner = reminder.user_id === interaction.user.id;
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

        if (!isOwner && !isAdmin) {
            return interaction.reply({
                content: `❌ Kamu hanya bisa membatalkan pengingat yang kamu buat sendiri (<@${reminder.user_id}>)!`,
                flags: MessageFlags.Ephemeral
            });
        }

        db.prepare('DELETE FROM reminders WHERE id = ?').run(reminderId);

        return interaction.reply({
            content: `🗑️ Jadwal pengingat **#${reminderId} (${reminder.title})** berhasil dibatalkan!`,
            flags: MessageFlags.Ephemeral
        });
    }
});

client.login(process.env.DISCORD_TOKEN);