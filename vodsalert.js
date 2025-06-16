const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  SlashCommandBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Collection,
  ChannelType,
  StringSelectMenuBuilder,
  ActivityType
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('./config.json');
const sqlite3 = require('better-sqlite3');
const schedule = require('node-schedule');
const fetch = require('node-fetch');
const triviaQuestions = require('./triviaQuestions.js');

// Clear module cache
delete require.cache[require.resolve('./commands.js')];
const slashCommands = require('./commands.js');

// Configuration du logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.File({ filename: 'error.log', level: 'error' })
  ]
});

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

// Attacher config et db au client
client.config = config;
client.db = sqlite3('./bot.db', { verbose: logger.info.bind(logger) });
client.db.pragma('journal_mode = WAL');

// Ajouter la colonne id à la table messages si elle n'existe pas
client.db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    date TEXT
  );
`);

// Charger les fichiers de traduction
const translations = {
  fr: require('/home/container/lang/fr.json'),
  'en-US': require('/home/container/lang/en-US.json')
};

// Fonction de traduction
function t(lang, key, placeholders = {}) {
  let message = translations[lang]?.[key] || translations.fr[key] || key;
  for (const [k, v] of Object.entries(placeholders)) {
    message = message.replace(`{{${k}}}`, v);
  }
  return message;
}

// Initialiser les tables de la base de données
function initializeDatabase() {
  client.db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (userId TEXT PRIMARY KEY, bio TEXT, games TEXT, socials TEXT, achievements TEXT);
    CREATE TABLE IF NOT EXISTS reputation (userId TEXT, giverId TEXT, points INTEGER, lastGiven TEXT, PRIMARY KEY (userId, giverId));
    CREATE TABLE IF NOT EXISTS voiceRoles (channelId TEXT PRIMARY KEY, roleId TEXT);
    CREATE TABLE IF NOT EXISTS giveaways (giveawayId TEXT PRIMARY KEY, messageId TEXT, channelId TEXT, prize TEXT, winnersCount INTEGER, endTime INTEGER);
    CREATE TABLE IF NOT EXISTS participants (giveawayId TEXT, userId TEXT, PRIMARY KEY (giveawayId, userId));
    CREATE TABLE IF NOT EXISTS levels (userId TEXT PRIMARY KEY, xp INTEGER, level INTEGER);
    CREATE TABLE IF NOT EXISTS quests (questId TEXT PRIMARY KEY, objective TEXT, reward TEXT, endTime INTEGER, progress INTEGER, total INTEGER);
    CREATE TABLE IF NOT EXISTS quest_participants (questId TEXT, userId TEXT, PRIMARY KEY (questId, userId));
    CREATE TABLE IF NOT EXISTS polls (pollId TEXT PRIMARY KEY, messageId TEXT, channelId TEXT, question TEXT, options TEXT, votes TEXT, endTime INTEGER);
    CREATE TABLE IF NOT EXISTS events (eventId TEXT PRIMARY KEY, messageId TEXT, channelId TEXT, title TEXT, description TEXT, date INTEGER);
    CREATE TABLE IF NOT EXISTS event_participants (eventId TEXT, userId TEXT, PRIMARY KEY (eventId, userId));
    CREATE TABLE IF NOT EXISTS warnings (userId TEXT, timestamp INTEGER, reason TEXT);
    CREATE TABLE IF NOT EXISTS trivia_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, options TEXT, answer INTEGER);
    CREATE TABLE IF NOT EXISTS trivia_history (userId TEXT, questionId INTEGER, timestamp INTEGER, PRIMARY KEY (userId, questionId));
  `);

  // Insérer les questions trivia depuis triviaQuestions.js si la table est vide
  const triviaCountStmt = client.db.prepare('SELECT COUNT(*) as count FROM trivia_questions');
  const triviaCount = triviaCountStmt.get().count;
  if (triviaCount === 0) {
    const stmt = client.db.prepare('INSERT INTO trivia_questions (question, options, answer) VALUES (?, ?, ?)');
    triviaQuestions.forEach(q => stmt.run(q.question, JSON.stringify(q.options), q.answer));
    logger.info('Questions trivia chargées depuis triviaQuestions.js.');
  }

  // Insérer une quête quotidienne par défaut
  const questCountStmt = client.db.prepare('SELECT COUNT(*) as count FROM quests');
  const questCount = questCountStmt.get().count;
  if (questCount === 0) {
    const questId = Date.now().toString();
    const endTime = Date.now() + 24 * 60 * 60 * 1000; // 24h
    const stmt = client.db.prepare('INSERT INTO quests (questId, objective, reward, endTime, progress, total) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(questId, 'Envoyer 10 messages', '50 XP', endTime, 0, 10);
    logger.info('Quête quotidienne par défaut créée.');
  }

  logger.info('Base de données initialisée.');
}

initializeDatabase();

// Collections pour les données en mémoire
client.commands = new Collection();
client.giveawayParticipants = new Collection();
client.activeGiveaways = new Collection();
client.activePolls = new Collection();
client.eventParticipants = new Collection();
client.userWarnings = new Collection();
client.questParticipants = new Collection();
client.voiceRoles = new Collection();

// Utilitaire : Créer un embed
function createEmbed(title, description, color = '#FFD700', options = {}) {
  const { footerText = config.botName, footerIcon = config.botAvatar, thumbnail, image, fields = [], timestamp = true } = options;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: footerText, iconURL: footerIcon });

  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);
  if (fields.length) embed.addFields(fields);
  if (timestamp) embed.setTimestamp();

  return embed;
}

// Envoyer un message aux admins
async function sendMessageToAdmins(interaction, message, reason) {
  const adminChannel = client.channels.cache.get(config.modChannelId);
  if (!adminChannel) return;

  const embed = createEmbed(
    t('fr', 'admin_message_title'),
    t('fr', 'admin_message_desc', { user: interaction.user.tag, reason, message }),
    '#0099ff'
  );

  await adminChannel.send({ embeds: [embed] });
  await interaction.reply({ content: t('fr', 'admin_message_sent'), ephemeral: true });
}

// Gérer le mute
async function handleMute(member, duration = 20, reason = 'Avertissements automatiques') {
  const muteRole = member.guild.roles.cache.get(config.muteRoleId);
  if (!muteRole) return false;

  try {
    // Supprimer les rôles spécifiés
    for (const roleId of (config.rolesToRemoveOnMute || [])) {
      const role = member.guild.roles.cache.get(roleId);
      if (role && member.roles.cache.has(roleId)) {
        await member.roles.remove(role).catch(error => logger.error(`Erreur suppression rôle ${roleId} : ${error.message}`));
      }
    }

    await member.roles.add(muteRole);
    const muteEmbed = createEmbed(
      t('fr', 'mute_title'),
      t('fr', 'mute_desc', { duration }),
      '#FF0000'
    );

    await member.send({ embeds: [muteEmbed] }).catch(() => {});

    setTimeout(async () => {
      await member.roles.remove(muteRole).catch(() => {});
      const unmuteEmbed = createEmbed(
        t('fr', 'unmute_title'),
        t('fr', 'unmute_desc'),
        '#00FF00'
      );
      await member.send({ embeds: [unmuteEmbed] }).catch(() => {});
      client.userWarnings.delete(member.id);
    }, duration * 60 * 1000);

    return true;
  } catch (error) {
    logger.error(`Erreur lors du mute : ${error.message}`);
    return false;
  }
}

// Ajouter de l'XP à un utilisateur
async function addXP(userId, amount) {
  const stmt = client.db.prepare('SELECT * FROM levels WHERE userId = ?');
  const row = stmt.get(userId);
  const newXP = (row?.xp || 0) + amount;
  const newLevel = Math.floor(newXP / 100); // 100 XP par niveau

  if (!row) {
    const insertStmt = client.db.prepare('INSERT INTO levels (userId, xp, level) VALUES (?, ?, ?)');
    insertStmt.run(userId, newXP, newLevel);
  } else if (newLevel > row.level) {
    const updateStmt = client.db.prepare('UPDATE levels SET xp = ?, level = ? WHERE userId = ?');
    updateStmt.run(newXP, newLevel, userId);
    await assignLevelRole(userId, newLevel);
  } else {
    const updateStmt = client.db.prepare('UPDATE levels SET xp = ? WHERE userId = ?');
    updateStmt.run(newXP, userId);
  }
  await checkAchievements(userId, newXP);
}

// Assigner des rôles de niveau
async function assignLevelRole(userId, level) {
  const guild = client.guilds.cache.get(config.guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const levelRoles = config.levelRoles || {};

  for (const [lvl, roleId] of Object.entries(levelRoles)) {
    if (roleId && level >= parseInt(lvl)) {
      const role = guild.roles.cache.get(roleId);
      if (role && !member.roles.cache.has(roleId)) {
        await member.roles.add(role).catch(error => logger.error(`Erreur ajout rôle ${roleId} : ${error.message}`));
      }
    }
  }

  // Supprimer les rôles de niveau inférieur
  for (const [lvl, roleId] of Object.entries(levelRoles)) {
    if (roleId && level < parseInt(lvl)) {
      const role = guild.roles.cache.get(roleId);
      if (role && member.roles.cache.has(roleId)) {
        await member.roles.remove(role).catch(error => logger.error(`Erreur suppression rôle ${roleId} : ${error.message}`));
      }
    }
  }
}

// Vérifier les achievements
async function checkAchievements(userId, xp) {
  const messageCountStmt = client.db.prepare('SELECT COUNT(*) as count FROM messages WHERE userId = ?');
  const messageCount = messageCountStmt.get(userId)?.count || 0;
  const giveawayCountStmt = client.db.prepare('SELECT COUNT(*) as count FROM participants WHERE userId = ?');
  const giveawayCount = giveawayCountStmt.get(userId)?.count || 0;
  const guild = client.guilds.cache.get(config.guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const channel = guild.channels.cache.get(config.publicChannelId);

  const profileStmt = client.db.prepare('SELECT achievements FROM profiles WHERE userId = ?');
  let profile = profileStmt.get(userId);
  profile = profile ? { achievements: JSON.parse(profile.achievements || '[]') } : { achievements: [] };

  const achievements = [
    {
      id: 'message_100',
      condition: messageCount >= 100,
      badge: config.achievementBadges?.message_100,
      message: t('fr', 'achievement_message_100')
    },
    {
      id: 'giveaway_5',
      condition: giveawayCount >= 5,
      badge: config.achievementBadges?.giveaway_5,
      message: t('fr', 'achievement_giveaway_5')
    }
  ];

  for (const ach of achievements) {
    if (ach.condition && !profile.achievements.includes(ach.id)) {
      const embed = createEmbed(
        t('fr', 'achievement_title', { username: member.user.username }),
        `${ach.badge?.emoji || '🏆'} **${t('fr', ach.badge?.name || ach.id)}**: ${ach.message}`,
        '#FFD700'
      );
      await channel.send({ embeds: [embed] });
      profile.achievements.push(ach.id);
      const upsertStmt = client.db.prepare('INSERT OR REPLACE INTO profiles (userId, achievements) VALUES (?, ?)');
      upsertStmt.run(userId, JSON.stringify(profile.achievements));
    }
  }
}

// Vérifier les mentions interdites
function checkForbiddenMentions(message) {
  const mentionedRoles = message.mentions.roles.map(r => r.id);
  const mentionedUsers = message.mentions.users.map(u => u.id);

  const forbiddenRoles = (config.forbiddenMentions?.roles || []).some(roleId => mentionedRoles.includes(roleId));
  const forbiddenUsers = (config.forbiddenMentions?.users || []).some(userId => mentionedUsers.includes(roleId));

  return forbiddenRoles || forbiddenUsers;
}

// Vérifier les mots inappropriés
function checkInappropriateWords(message) {
  const content = message.content.toLowerCase();
  return (config.inappropriateWords || []).some(word => content.includes(word.toLowerCase()));
}

// Sélectionner une question trivia non posée récemment
async function selectTriviaQuestion(userId) {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 jours
  const usedQuestionsStmt = client.db.prepare('SELECT questionId FROM trivia_history WHERE userId = ? AND timestamp > ?');
  const usedQuestions = usedQuestionsStmt.all(userId, oneWeekAgo).map(row => row.questionId);

  const availableQuestionsStmt = client.db.prepare('SELECT * FROM trivia_questions WHERE id NOT IN (' + usedQuestions.map(() => '?').join(',') + ')');
  const availableQuestions = usedQuestions.length ? availableQuestionsStmt.all(...usedQuestions) : client.db.prepare('SELECT * FROM trivia_questions').all();

  if (!availableQuestions.length) {
    // Réinitialiser l'historique si toutes les questions ont été posées
    client.db.prepare('DELETE FROM trivia_history WHERE userId = ?').run(userId);
    return client.db.prepare('SELECT * FROM trivia_questions').all()[Math.floor(Math.random() * triviaQuestions.length)];
  }

  return availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
}

// Enregistrer une question trivia posée
function logTriviaQuestion(userId, questionId) {
  const stmt = client.db.prepare('INSERT OR REPLACE INTO trivia_history (userId, questionId, timestamp) VALUES (?, ?, ?)');
  stmt.run(userId, questionId, Date.now());
}

// Enregistrer les commandes slash
async function registerSlashCommands(guild) {
  try {
    const existingCommands = await guild.commands.fetch();
    for (const command of existingCommands.values()) {
      await command.delete();
      logger.info(`Commande supprimée : ${command.name}`);
    }

    const newCommands = [
      new SlashCommandBuilder()
        .setName('setstatus')
        .setDescription(t('fr', 'setstatus_desc'))
        .addStringOption(option =>
          option.setName('type')
            .setDescription(t('fr', 'setstatus_type_desc'))
            .setRequired(true)
            .addChoices(
              { name: 'Jouer', value: 'PLAYING' },
              { name: 'Regarder', value: 'WATCHING' },
              { name: 'Écouter', value: 'LISTENING' }
            ))
        .addStringOption(option =>
          option.setName('name')
            .setDescription(t('fr', 'setstatus_name_desc'))
            .setRequired(true))
        .addStringOption(option =>
          option.setName('status')
            .setDescription(t('fr', 'setstatus_status_desc'))
            .setRequired(true)
            .addChoices(
              { name: 'En ligne', value: 'online' },
              { name: 'Inactif', value: 'idle' },
              { name: 'Ne pas déranger', value: 'dnd' },
              { name: 'Invisible', value: 'invisible' }
            )),
      new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription(t('fr', 'leaderboard_desc'))
        .addStringOption(option =>
          option.setName('type')
            .setDescription(t('fr', 'leaderboard_type_desc'))
            .setRequired(true)
            .addChoices(
              { name: 'XP', value: 'xp' },
              { name: 'Réputation', value: 'rep' }
            ))
    ];

    for (const command of [...slashCommands, ...newCommands]) {
      await guild.commands.create(command instanceof SlashCommandBuilder ? command.toJSON() : command.data.toJSON());
      logger.info(`Commande enregistrée : ${command instanceof SlashCommandBuilder ? command.name : command.data.name}`);
    }
    logger.info(t('fr', 'commands_registered'));
  } catch (error) {
    logger.error(`Erreur lors de l'enregistrement des commandes : ${error.message}`);
  }
}

// Gérer les règles
async function manageRules() {
  const rulesChannel = client.channels.cache.get(config.rulesChannelId);
  if (!rulesChannel) throw new Error(t('fr', 'rules_channel_not_found'));

  const messages = await rulesChannel.messages.fetch();
  const existingMessage = messages.find(
    msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title.includes(t('fr', 'rules_title'))
  );

  const rulesEmbed = createEmbed(
    '📜 ' + t('fr', 'rules_title'),
    t('fr', 'rules_desc'),
    '#00FF00'
  );

  const acceptButton = new ButtonBuilder()
    .setCustomId('rules_accept_button')
    .setLabel(t('fr', 'rules_accept_button'))
    .setStyle(ButtonStyle.Primary);

  const translateButton = new ButtonBuilder()
    .setCustomId('rules_translate_button')
    .setLabel(t('fr', 'rules_translate_button'))
    .setStyle(ButtonStyle.Secondary);

  if (existingMessage) {
    await existingMessage.edit({
      embeds: [rulesEmbed],
      components: [new ActionRowBuilder().addComponents(acceptButton, translateButton)]
    });
    logger.info(t('fr', 'rules_message_updated'));
  } else {
    await rulesChannel.send({
      embeds: [rulesEmbed],
      components: [new ActionRowBuilder().addComponents(acceptButton, translateButton)]
    });
    logger.info(t('fr', 'rules_message_sent'));
  }
}

// Initialisation du bot
async function initializeBot() {
  const guild = await client.guilds.fetch(config.guildId);
  if (!guild) throw new Error(t('fr', 'guild_not_found'));

  logger.info(t('fr', 'guild_fetched', { name: guild.name }));
  await manageRules();
  await registerSlashCommands(guild);

  // Charger les giveaways
  const giveawayStmt = client.db.prepare('SELECT * FROM giveaways WHERE endTime > ?');
  const giveaways = giveawayStmt.all(Date.now());
  for (const row of giveaways) {
    const participantStmt = client.db.prepare('SELECT userId FROM participants WHERE giveawayId = ?');
    const participants = new Set(participantStmt.all(row.giveawayId).map(p => p.userId));
    client.activeGiveaways.set(row.giveawayId, {
      messageId: row.messageId,
      channelId: row.channelId,
      prize: row.prize,
      winnersCount: row.winnersCount,
      endTime: row.endTime,
      participants
    });
    client.giveawayParticipants.set(row.giveawayId, participants);
  }

  // Charger les polls
  const pollStmt = client.db.prepare('SELECT * FROM polls WHERE endTime > ?');
  const polls = pollStmt.all(Date.now());
  for (const row of polls) {
    client.activePolls.set(row.pollId, {
      messageId: row.messageId,
      channelId: row.channelId,
      question: row.question,
      options: JSON.parse(row.options),
      votes: JSON.parse(row.votes),
      endTime: row.endTime
    });
  }

  // Charger les événements
  const eventStmt = client.db.prepare('SELECT * FROM events WHERE date > ?');
  const events = eventStmt.all(Date.now());
  for (const row of events) {
    const eventParticipantStmt = client.db.prepare('SELECT userId FROM event_participants WHERE eventId = ?');
    const participants = new Set(eventParticipantStmt.all(row.eventId).map(p => p.userId));
    client.eventParticipants.set(row.eventId, participants);
  }

  // Charger les quêtes
  const questStmt = client.db.prepare('SELECT * FROM quests WHERE endTime > ?');
  const quests = questStmt.all(Date.now());
  for (const row of quests) {
    const questParticipantStmt = client.db.prepare('SELECT userId FROM quest_participants WHERE questId = ?');
    const participants = new Set(questParticipantStmt.all(row.questId).map(p => p.userId));
    client.questParticipants.set(row.questId, participants);
  }

  // Charger les rôles vocaux
  const voiceRoleStmt = client.db.prepare('SELECT * FROM voiceRoles');
  const voiceRoles = voiceRoleStmt.all();
  voiceRoles.forEach(row => client.voiceRoles.set(row.channelId, row.roleId));
}

// Charger et enregistrer les commandes
slashCommands.forEach(command => {
  if (command.data?.name) {
    client.commands.set(command.data.name, command);
  } else {
    logger.error(`Commande invalide : ${JSON.stringify(command)}`);
  }
});

// Ajouter la commande setstatus
client.commands.set('setstatus', {
  data: new SlashCommandBuilder()
    .setName('setstatus')
    .setDescription(t('fr', 'setstatus_desc'))
    .addStringOption(option =>
      option.setName('type')
        .setDescription(t('fr', 'setstatus_type_desc'))
        .setRequired(true)
        .addChoices(
          { name: 'Jouer', value: 'PLAYING' },
          { name: 'Regarder', value: 'WATCHING' },
          { name: 'Écouter', value: 'LISTENING' }
        ))
    .addStringOption(option =>
      option.setName('name')
        .setDescription(t('fr', 'setstatus_name_desc'))
        .setRequired(true))
    .addStringOption(option =>
      option.setName('status')
        .setDescription(t('fr', 'setstatus_status_desc'))
        .setRequired(true)
        .addChoices(
          { name: 'En ligne', value: 'online' },
          { name: 'Inactif', value: 'idle' },
          { name: 'Ne pas déranger', value: 'dnd' },
          { name: 'Invisible', value: 'invisible' }
        )),
  async execute(interaction) {
    const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
    if (!interaction.member.roles.cache.some(role => (config.authorizedRoles || []).includes(role.id))) {
      await interaction.reply({ content: t(lang, 'no_permission'), ephemeral: true });
      return;
    }

    const type = interaction.options.getString('type');
    const name = interaction.options.getString('name');
    const status = interaction.options.getString('status');

    const activityTypes = {
      PLAYING: ActivityType.Playing,
      WATCHING: ActivityType.Watching,
      LISTENING: ActivityType.Listening
    };

    if (!activityTypes[type]) {
      await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
      return;
    }

    await client.user.setPresence({
      status,
      activities: [{ name, type: activityTypes[type] }]
    });

    const embed = createEmbed(
      t(lang, 'setstatus_title'),
      t(lang, 'setstatus_desc', { status, type: type.toLowerCase(), name }),
      '#00FF00'
    );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// Ajouter la commande leaderboard
client.commands.set('leaderboard', {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription(t('fr', 'leaderboard_desc'))
    .addStringOption(option =>
      option.setName('type')
        .setDescription(t('fr', 'leaderboard_type_desc'))
        .setRequired(true)
        .addChoices(
          { name: 'XP', value: 'xp' },
          { name: 'Réputation', value: 'rep' }
        )),
  async execute(interaction) {
    const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
    const type = interaction.options.getString('type');

    let users;
    if (type === 'xp') {
      const stmt = client.db.prepare('SELECT userId, xp FROM levels ORDER BY xp DESC LIMIT 10');
      users = stmt.all();
    } else {
      const stmt = client.db.prepare('SELECT userId, SUM(points) as points FROM reputation GROUP BY userId ORDER BY points DESC LIMIT 10');
      users = stmt.all();
    }

    if (!users.length) {
      await interaction.reply({ content: t(lang, 'stats_no_data'), ephemeral: true });
      return;
    }

    const list = await Promise.all(users.map(async (user, index) => {
      const member = await interaction.guild.members.fetch(user.userId).catch(() => null);
      const value = type === 'xp' ? user.xp : user.points;
      return `${index + 1}. ${member ? member.user.tag : 'Utilisateur inconnu'} - ${value} ${type === 'xp' ? 'XP' : 'points'}`;
    }));

    const embed = createEmbed(
      t(lang, 'leaderboard_title'),
      list.join('\n'),
      '#FFD700'
    );

    await interaction.reply({ embeds: [embed] });
  }
});

// Événement ready
client.once('ready', async () => {
  try {
    logger.info(t('fr', 'bot_ready', { tag: client.user.tag }));
    client.user.setPresence({
      status: 'online',
      activities: [{ name: config.defaultStatus.message, type: ActivityType[config.defaultStatus.type] }]
    });
    await initializeBot();
    scheduleWeeklyGiveaway();
    scheduleDailyQuest();
    scheduleQuestProgress();
    schedulePollExpirations();
    scheduleEventReminders();
  } catch (error) {
    logger.error(`Erreur initialisation : ${error.message}`);
  }
});

// Événement guildMemberAdd
client.on('guildMemberAdd', async member => {
  try {
    const channel = member.guild.channels.cache.get(config.welcomeMessageChannelId);
    if (!channel) return;

    const embed = createEmbed(
      t('fr', 'welcome_title'),
      t('fr', 'welcome_desc', { user: member.user.tag, rulesChannelId: config.rulesChannelId }),
      '#00FF00',
      {
        thumbnail: member.user.displayAvatarURL({ dynamic: true }),
        image: config.welcomeImage,
        footerText: t('fr', 'welcome_footer', { count: member.guild.memberCount })
      }
    );

    await channel.send({ embeds: [embed] });
    await member.send({
      embeds: [
        createEmbed(
          t('fr', 'dm_welcome_title'),
          t('fr', 'dm_welcome_desc'),
          '#00FF00'
        )
      ]
    }).catch(() => {});
  } catch (error) {
    logger.error(`Erreur guildMemberAdd : ${error.message}`);
  }
});

// Événement guildMemberRemove
client.on('guildMemberRemove', async member => {
  try {
    const channel = member.guild.channels.cache.get(config.welcomeMessageChannelId);
    if (!channel) return;

    const embed = createEmbed(
      t('fr', 'goodbye_title'),
      t('fr', 'goodbye_desc', { user: member.user.tag }),
      '#FF0000',
      {
        thumbnail: member.user.displayAvatarURL({ dynamic: true }),
        image: config.goodbyeImage,
        footerText: t('fr', 'goodbye_footer', { count: member.guild.memberCount })
      }
    );

    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.error(`Erreur guildMemberRemove : ${error.message}`);
  }
});

// Événement voiceStateUpdate
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState.member;
    const oldChannel = oldState.channel;
    const newChannel = newState.channel;

    if (oldChannel && client.voiceRoles.has(oldChannel.id)) {
      const roleId = client.voiceRoles.get(oldChannel.id);
      await member.roles.remove(roleId).catch(() => {});
    }
    if (newChannel && client.voiceRoles.has(newChannel.id)) {
      const roleId = client.voiceRoles.get(newChannel.id);
      await member.roles.add(roleId).catch(() => {});
    }
  } catch (error) {
    logger.error(`Erreur voiceStateUpdate : ${error.message}`);
  }
});

// Événement interactionCreate
client.on('interactionCreate', async interaction => {
  try {
    const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) {
        await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
        return;
      }
      await command.execute(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('annonceModal_')) {
        const schedule = interaction.customId.split('_')[1];
        const typeAnnonce = interaction.fields.getTextInputValue('typeAnnonce');
        const communityBenefit = interaction.fields.getTextInputValue('communityBenefit');
        const goodNews = interaction.fields.getTextInputValue('goodNews');
        const roleId = interaction.fields.getTextInputValue('roleMention');
        const attachmentUrl = interaction.fields.getTextInputValue('attachmentUrl') || null;

        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          await interaction.reply({ content: t(lang, 'annonce_invalid_role'), ephemeral: true });
          return;
        }

        const channel = client.channels.cache.get(config.announcementChannelId);
        if (!channel) {
          await interaction.reply({ content: t(lang, 'annonce_channel_not_found'), ephemeral: true });
          return;
        }

        const embed = createEmbed(
          t(lang, 'annonce_title'),
          t(lang, 'annonce_desc_text', { type: typeAnnonce, benefit: communityBenefit, news: goodNews }),
          '#FF4C4C',
          { image: attachmentUrl }
        );

        const sendAnnouncement = async () => {
          const message = await channel.send({
            content: t(lang, 'annonce_content', { roleId }),
            embeds: [embed]
          });
          const yesEmoji = interaction.guild.emojis.cache.find(emoji => emoji.name === 'yes') || '✅';
          await message.react(yesEmoji);
        };

        if (schedule === 'immediate') {
          await sendAnnouncement();
          await interaction.reply({ content: t(lang, 'annonce_success'), ephemeral: true });
        } else {
          const scheduledTime = new Date(schedule);
          if (isNaN(scheduledTime.getTime())) {
            await interaction.reply({ content: t(lang, 'annonce_invalid_schedule'), ephemeral: true });
            return;
          }
          schedule.scheduleJob(scheduledTime, sendAnnouncement);
          await interaction.reply({
            content: t(lang, 'annonce_scheduled', { time: scheduledTime.toLocaleString() }),
            ephemeral: true
          });
        }
      } else if (interaction.customId === 'giveawayModal') {
        const condition = interaction.fields.getTextInputValue('condition') || t(lang, 'gcreate_no_condition');
        const prize = interaction.fields.getTextInputValue('prize');
        const durationMinutes = parseInt(interaction.fields.getTextInputValue('duration'), 10);
        const winnersCount = parseInt(interaction.fields.getTextInputValue('winners'), 10);

        const channel = client.channels.cache.get(config.giveawayAnnouncementChannelId);
        if (!channel) {
          await interaction.reply({ content: t(lang, 'gcreate_channel_not_found'), ephemeral: true });
          return;
        }

        if (isNaN(durationMinutes) || durationMinutes <= 0 || isNaN(winnersCount) || winnersCount <= 0) {
          await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
          return;
        }

        const giveawayId = Date.now().toString();
        const participants = new Set();
        client.giveawayParticipants.set(giveawayId, participants);

        const embed = createEmbed(
          t(lang, 'gcreate_title'),
          t(lang, 'gcreate_desc_text', {
            condition,
            prize,
            winners: winnersCount,
            participants: 0,
            minutes: durationMinutes,
            seconds: 0
          }),
          '#FF5733'
        );

        const participateButton = new ButtonBuilder()
          .setCustomId(`participate_${giveawayId}`)
          .setLabel(t(lang, 'gcreate_participate_button'))
          .setStyle(ButtonStyle.Success);

        const message = await channel.send({
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(participateButton)]
        });

        const endTime = Date.now() + durationMinutes * 60 * 1000;
        client.activeGiveaways.set(giveawayId, {
          messageId: message.id,
          channelId: channel.id,
          prize,
          winnersCount,
          participants,
          endTime
        });

        const giveawayStmt = client.db.prepare('INSERT INTO giveaways (giveawayId, messageId, channelId, prize, winnersCount, endTime) VALUES (?, ?, ?, ?, ?, ?)');
        giveawayStmt.run(giveawayId, message.id, channel.id, prize, winnersCount, endTime);

        scheduleGiveawayCountdown(giveawayId, durationMinutes * 60, condition, prize, winnersCount, message, participateButton);
        await interaction.reply({ content: t(lang, 'gcreate_success'), ephemeral: true });
      } else if (interaction.customId === 'updateRulesModal') {
        const rulesText = interaction.fields.getTextInputValue('rulesText');
        const rulesChannel = client.channels.cache.get(config.rulesChannelId);
        if (!rulesChannel) {
          await interaction.reply({ content: t(lang, 'rules_channel_not_found'), ephemeral: true });
          return;
        }

        const rulesEmbed = createEmbed(
          t(lang, 'rules_title'),
          rulesText,
          '#00FF00'
        );

        const acceptButton = new ButtonBuilder()
          .setCustomId('rules_accept_button')
          .setLabel(t(lang, 'rules_accept_button'))
          .setStyle(ButtonStyle.Primary);

        const translateButton = new ButtonBuilder()
          .setCustomId('rules_translate_button')
          .setLabel(t(lang, 'rules_translate_button'))
          .setStyle(ButtonStyle.Secondary);

        const messages = await rulesChannel.messages.fetch();
        const existingMessage = messages.find(
          msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title.includes(t(lang, 'rules_title'))
        );

        if (existingMessage) {
          await existingMessage.edit({
            embeds: [rulesEmbed],
            components: [new ActionRowBuilder().addComponents(acceptButton, translateButton)]
          });
        } else {
          await rulesChannel.send({
            embeds: [rulesEmbed],
            components: [new ActionRowBuilder().addComponents(acceptButton, translateButton)]
          });
        }

        await interaction.reply({ content: t(lang, 'updaterules_success'), ephemeral: true });
        logger.info(t(lang, 'rules_message_updated'));
      } else if (interaction.customId === 'pollModal') {
        const question = interaction.fields.getTextInputValue('question');
        const option1 = interaction.fields.getTextInputValue('option1');
        const option2 = interaction.fields.getTextInputValue('option2');
        const option3 = interaction.fields.getTextInputValue('option3') || null;
        const durationMinutes = parseInt(interaction.fields.getTextInputValue('duration'), 10);

        const channel = client.channels.cache.get(config.pollChannelId);
        if (!channel) {
          await interaction.reply({ content: t(lang, 'poll_channel_not_found'), ephemeral: true });
          return;
        }

        if (isNaN(durationMinutes) || durationMinutes <= 0) {
          await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
          return;
        }

        const pollId = Date.now().toString();
        const options = [option1, option2];
        if (option3) options.push(option3);
        const votes = new Array(options.length).fill(0);

        const embed = createEmbed(
          t(lang, 'poll_title', { question }),
          options.map((opt, i) => `${i + 1}. ${opt} (${votes[i]} votes)`).join('\n'),
          '#FFD700'
        );

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`poll_vote_${pollId}`)
          .setPlaceholder(t(lang, 'poll_vote_placeholder', { question }))
          .addOptions(options.map((opt, i) => ({
            label: opt,
            value: i.toString()
          })));

        const message = await channel.send({
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(selectMenu)]
        });

        const endTime = Date.now() + durationMinutes * 60 * 1000;
        client.activePolls.set(pollId, { messageId: message.id, channelId: channel.id, question, options, votes, endTime });

        const pollStmt = client.db.prepare('INSERT INTO polls (pollId, messageId, channelId, question, options, votes, endTime) VALUES (?, ?, ?, ?, ?, ?, ?)');
        pollStmt.run(pollId, message.id, channel.id, question, JSON.stringify(options), JSON.stringify(votes), endTime);

        await interaction.reply({ content: t(lang, 'poll_success'), ephemeral: true });
      } else if (interaction.customId === 'eventModal') {
        const title = interaction.fields.getTextInputValue('title');
        const description = interaction.fields.getTextInputValue('description');
        const date = new Date(interaction.fields.getTextInputValue('date'));
        const roleId = interaction.fields.getTextInputValue('role');
        const eventId = Date.now().toString();

        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          await interaction.reply({ content: t(lang, 'event_invalid_role'), ephemeral: true });
          return;
        }

        const channel = client.channels.cache.get(config.eventChannelId);
        if (!channel) {
          await interaction.reply({ content: t(lang, 'event_channel_not_found'), ephemeral: true });
          return;
        }

        if (isNaN(date.getTime())) {
          await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
          return;
        }

        const embed = createEmbed(
          t(lang, 'event_title', { title }),
          t(lang, 'event_desc', { description, date: date.toLocaleString() }),
          '#FFD700'
        );

        const participateButton = new ButtonBuilder()
          .setCustomId(`event_participate_${eventId}`)
          .setLabel(t(lang, 'event_participate_button'))
          .setStyle(ButtonStyle.Success);

        const message = await channel.send({
          content: t(lang, 'event_content', { roleId }),
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(participateButton)]
        });

        client.eventParticipants.set(eventId, new Set());
        const eventStmt = client.db.prepare('INSERT INTO events (eventId, messageId, channelId, title, description, date) VALUES (?, ?, ?, ?, ?, ?)');
        eventStmt.run(eventId, message.id, channel.id, title, description, date.getTime());

        await interaction.reply({ content: t(lang, 'event_success'), ephemeral: true });
      } else if (interaction.customId === 'memeModal') {
        if (!config.imgflipUsername || !config.imgflipPassword) {
          await interaction.reply({ content: t(lang, 'meme_config_missing'), ephemeral: true });
          return;
        }

        const template = interaction.fields.getTextInputValue('template');
        const topText = interaction.fields.getTextInputValue('topText');
        const bottomText = interaction.fields.getTextInputValue('bottomText');

        try {
          const response = await fetch(`https://api.imgflip.com/caption_image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              template_id: template,
              username: config.imgflipUsername,
              password: config.imgflipPassword,
              text0: topText,
              text1: bottomText
            })
          });
          const data = await response.json();
          if (!data.success) throw new Error('Erreur API Imgflip: ' + data.error_message);
          const memeUrl = data.data.url;

          const embed = createEmbed(
            t(lang, 'meme_title'),
            null,
            '#FFD700',
            { image: memeUrl }
          );

          await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          logger.error(`Erreur meme : ${error.message}`);
          await interaction.reply({ content: t(lang, 'meme_error'), ephemeral: true });
        }
      } else if (interaction.customId === 'questModal') {
        const objective = interaction.fields.getTextInputValue('objective');
        const reward = interaction.fields.getTextInputValue('reward');
        const durationMinutes = parseInt(interaction.fields.getTextInputValue('duration'), 10);

        const channel = client.channels.cache.get(config.questChannelId);
        if (!channel) {
          await interaction.reply({ content: t(lang, 'quest_channel_not_found'), ephemeral: true });
          return;
        }

        if (isNaN(durationMinutes) || durationMinutes <= 0) {
          await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true });
          return;
        }

        const questId = Date.now().toString();
        const endTime = Date.now() + durationMinutes * 60 * 1000;

        const embed = createEmbed(
          t(lang, 'quest_title'),
          t(lang, 'quest_desc', { objective, reward, minutes: durationMinutes }),
          '#FFD700'
        );

        const participateButton = new ButtonBuilder()
          .setCustomId(`quest_participate_${questId}`)
          .setLabel(t('fr', 'quest_participate_button', { objective }))
          .setStyle(ButtonStyle.Success);

        await channel.send({
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(participateButton)]
        });

        const questStmt = client.db.prepare('INSERT INTO quests (questId, objective, reward, endTime, progress, total) VALUES (?, ?, ?, ?, ?, ?)');
        questStmt.run(questId, objective, reward, endTime, 0, 100);

        client.questParticipants.set(questId, new Set());
        await interaction.reply({ content: t(lang, 'quest_success'), ephemeral: true });
      } else if (interaction.customId === 'emojiModal') {
        const name = interaction.fields.getTextInputValue('name');
        const imageUrl = interaction.fields.getTextInputValue('image');

        try {
          const emoji = await interaction.guild.emojis.create({ attachment: imageUrl, name });
          await interaction.reply({ content: t(lang, 'custom_emoji_success', { emoji: `<:${name}:${emoji.id}>` }), ephemeral: true });
        } catch (error) {
          logger.error(`Erreur création emoji : ${error.message}`);
          await interaction.reply({ content: t(lang, 'custom_emoji_error'), ephemeral: true });
        }
      } else if (interaction.customId === 'profileModal') {
        const bio = interaction.fields.getTextInputValue('bio') || 'Aucune bio';
        const games = interaction.fields.getTextInputValue('games') || 'Aucun jeu';
        const socials = interaction.fields.getTextInputValue('socials') || 'Aucun réseau';

        const profileStmt = client.db.prepare('INSERT OR REPLACE INTO profiles (userId, bio, games, socials, achievements) VALUES (?, ?, ?, ?, COALESCE((SELECT achievements FROM profiles WHERE userId = ?), ?))');
        profileStmt.run(interaction.user.id, bio, games, socials, interaction.user.id, '[]');

        const embed = createEmbed(
          t(lang, 'profile_title', { username: interaction.user.username }),
          t(lang, 'profile_updated', { bio, games, socials }),
          '#00FF00'
        );

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } else if (interaction.customId === 'ticketFeedbackModal') {
        const feedback = interaction.fields.getTextInputValue('feedback');
        const feedbackEmbed = new EmbedBuilder()
          .setColor(0x6A0DAD)
          .setTitle(t(lang, 'ticket_feedback_title'))
          .setDescription(t(lang, 'ticket_feedback_desc', { user: interaction.user.tag, feedback }))
          .setTimestamp();

        await interaction.reply({ embeds: [feedbackEmbed] });
        const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
        if (logChannel) {
          await logChannel.send({ embeds: [feedbackEmbed] });
        }
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'rules_accept_button') {
        const role = interaction.guild.roles.cache.get(config.acceptRulesRoleId);
        if (!role) {
          await interaction.reply({ content: t(lang, 'rules_role_not_found'), ephemeral: true });
          return;
        }
        await interaction.member.roles.add(role);
        await interaction.reply({ content: t(lang, 'rules_accepted'), ephemeral: true });
      } else if (interaction.customId === 'rules_translate_button') {
        const embed = createEmbed(
          t('en-US', 'rules_title'),
          t('en-US', 'rules_desc'),
          '#00FF00'
        );
        await interaction.reply({ embeds: [embed], ephemeral: true });
      } else if (interaction.customId === 'close-ticket') {
        await interaction.deferReply({ ephemeral: true });

        // Vérifier les permissions
        const isTicketOwner = interaction.channel.name.includes(interaction.user.username.toLowerCase());
        const hasManageChannels = interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels);
        if (!isTicketOwner && !hasManageChannels) {
          await interaction.editReply({ content: t(lang, 'no_permission') });
          return;
        }

        // Envoyer un message de confirmation
        await interaction.channel.send({
          embeds: [createEmbed(
            t(lang, 'ticket_close_title'),
            t(lang, 'ticket_close_desc'),
            '#FF0000'
          )]
        });

        // Supprimer le canal après un délai
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
            const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
            if (logChannel) {
              await logChannel.send({
                embeds: [createEmbed(
                  t(lang, 'log_ticket_close_title'),
                  t(lang, 'log_ticket_close_desc', {
                    user: interaction.user.tag,
                    channel: interaction.channel.name
                  }),
                  '#FF0000'
                )]
              });
            }
          } catch (error) {
            logger.error(`Erreur lors de la suppression du ticket : ${error.message}`);
          }
        }, 5000);

        await interaction.editReply({ content: t(lang, 'ticket_close_success') });
      } else if (interaction.customId === 'edit-profile') {
        const modal = new ModalBuilder()
          .setCustomId('profileModal')
          .setTitle(t(lang, 'profile_edit_modal_title'));

        const inputs = [
          { id: 'bio', label: t(lang, 'profile_bio_label'), style: TextInputStyle.Paragraph, required: false },
          { id: 'games', label: t(lang, 'profile_games_label'), style: TextInputStyle.Paragraph, required: false },
          { id: 'socials', label: t(lang, 'profile_socials_label'), style: TextInputStyle.Paragraph, required: false }
        ];

        modal.addComponents(inputs.map(input =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(input.id)
              .setLabel(input.label)
              .setStyle(input.style)
              .setRequired(input.required)
          )
        ));

        await interaction.showModal(modal);
      } else if (interaction.customId.startsWith('participate_')) {
        const giveawayId = interaction.customId.split('_')[1];
        const participants = client.giveawayParticipants.get(giveawayId) || new Set();

        if (participants.has(interaction.user.id)) {
          await interaction.reply({ content: t(lang, 'gcreate_already_joined'), ephemeral: true });
          return;
        }

        participants.add(interaction.user.id);
        client.giveawayParticipants.set(giveawayId, participants);
        const participantStmt = client.db.prepare('INSERT INTO participants (giveawayId, userId) VALUES (?, ?)');
        participantStmt.run(giveawayId, interaction.user.id);

        await interaction.reply({ content: t(lang, 'gcreate_joined'), ephemeral: true });

        const giveaway = client.activeGiveaways.get(giveawayId);
        if (giveaway) {
          const message = await client.channels.cache.get(giveaway.channelId)?.messages.fetch(giveaway.messageId).catch(() => null);
          if (message) {
            const embed = new EmbedBuilder(message.embeds[0]);
            embed.setDescription(embed.description.replace(/Participants: \d+/, `Participants: ${participants.size}`));
            await message.edit({ embeds: [embed] });
          }
        }
      } else if (interaction.customId.startsWith('quest_participate_')) {
        const questId = interaction.customId.split('_')[2];
        const questStmt = client.db.prepare('SELECT * FROM quests WHERE questId = ?');
        const quest = questStmt.get(questId);
        const participants = client.questParticipants.get(questId) || new Set();

        if (!quest) {
          await interaction.reply({ content: t(lang, 'quest_not_found'), ephemeral: true });
          return;
        }

        if (participants.has(interaction.user.id)) {
          await interaction.reply({ content: t(lang, 'quest_already_joined'), ephemeral: true });
          return;
        }

        participants.add(interaction.user.id);
        client.questParticipants.set(questId, participants);
        const questParticipantStmt = client.db.prepare('INSERT INTO quest_participants (questId, userId) VALUES (?, ?)');
        questParticipantStmt.run(questId, interaction.user.id);

        await interaction.reply({ content: t(lang, 'quest_joined'), ephemeral: true });
      } else if (interaction.customId.startsWith('event_participate_')) {
        const eventId = interaction.customId.split('_')[2];
        const participants = client.eventParticipants.get(eventId) || new Set();

        if (participants.has(interaction.user.id)) {
          participants.delete(interaction.user.id);
          const deleteStmt = client.db.prepare('DELETE FROM event_participants WHERE eventId = ? AND userId = ?');
          deleteStmt.run(eventId, interaction.user.id);
          await interaction.reply({ content: t(lang, 'event_leave'), ephemeral: true });
        } else {
          participants.add(interaction.user.id);
          const insertStmt = client.db.prepare('INSERT INTO event_participants (eventId, userId) VALUES (?, ?)');
          insertStmt.run(eventId, interaction.user.id);
          await interaction.reply({ content: t(lang, 'event_join'), ephemeral: true });
        }
        client.eventParticipants.set(eventId, participants);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('poll_vote_')) {
        const pollId = interaction.customId.split('_')[2];
        const poll = client.activePolls.get(pollId);

        if (!poll) {
          await interaction.reply({ content: t(lang, 'poll_not_found'), ephemeral: true });
          return;
        }

        const voteIndex = parseInt(interaction.values[0]);
        poll.votes[voteIndex]++;
        client.activePolls.set(pollId, poll);

        const pollStmt = client.db.prepare('UPDATE polls SET votes = ? WHERE pollId = ?');
        pollStmt.run(JSON.stringify(poll.votes), pollId);

        const message = await client.channels.cache.get(poll.channelId)?.messages.fetch(poll.messageId).catch(() => null);
        if (message) {
          const embed = new EmbedBuilder(message.embeds[0]);
          embed.setDescription(poll.options.map((opt, i) => `${i + 1}. ${opt} (${poll.votes[i]} votes)`).join('\n'));
          await message.edit({ embeds: [embed] });
        }

        await interaction.reply({ content: t(lang, 'poll_voted'), ephemeral: true });
      }
    }
  } catch (error) {
    logger.error(`Erreur interaction : ${error.message}`);
    const lang = interaction.locale?.startsWith('fr') ? 'fr' : 'en-US';
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: t(lang, 'interaction_error'), ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: t(lang, 'interaction_error'), ephemeral: true }).catch(() => {});
    }
  }
});

// Événement messageCreate
client.on('messageCreate', async message => {
  try {
    if (message.author.bot || message.channel.type === ChannelType.DM) return;

    await addXP(message.author.id, config.xpPerMessage || 5);
    const messageStmt = client.db.prepare('INSERT INTO messages (userId, date) VALUES (?, ?)');
    messageStmt.run(message.author.id, new Date().toISOString().split('T')[0]);

    // Mettre à jour les quêtes quotidiennes
    const questStmt = client.db.prepare('SELECT * FROM quests WHERE endTime > ?');
    const quests = questStmt.all(Date.now());
    for (const quest of quests) {
      if (quest.objective.includes('Envoyer') && quest.objective.includes('messages')) {
        const participants = client.questParticipants.get(quest.questId) || new Set();
        if (participants.has(message.author.id)) {
          const newProgress = quest.progress + 1;
          const updateStmt = client.db.prepare('UPDATE quests SET progress = ? WHERE questId = ?');
          updateStmt.run(newProgress, quest.questId);
          if (newProgress >= quest.total) {
            const channel = client.channels.cache.get(config.dailyQuestChannelId);
            if (channel) {
              const embed = createEmbed(
                t('fr', 'quest_ended_title'),
                t('fr', 'quest_ended_desc', { objective: quest.objective, reward: quest.reward }),
                '#00FF00'
              );
              await channel.send({ embeds: [embed] });
              for (const userId of participants) {
                await addXP(userId, parseInt(quest.reward) || 50);
              }
            }
            const deleteStmt = client.db.prepare('DELETE FROM quests WHERE questId = ?');
            deleteStmt.run(quest.questId);
            client.questParticipants.delete(quest.questId);
          }
        }
      }
    }

    // Vérifier les mentions interdites
    if (checkForbiddenMentions(message)) {
      await message.delete();
      let warnings = client.userWarnings.get(message.author.id) || { count: 0, timestamps: [] };
      warnings.count++;
      warnings.timestamps.push(Date.now());
      client.userWarnings.set(message.author.id, warnings);

      const warningStmt = client.db.prepare('INSERT INTO warnings (userId, timestamp, reason) VALUES (?, ?, ?)');
      warningStmt.run(message.author.id, Date.now(), 'Mention interdite');

      const warningEmbed = createEmbed(
        t('fr', 'warning_title'),
        t('fr', 'warning_desc', { reason: 'Mention interdite' }),
        '#FF0000'
      );

      await message.author.send({ embeds: [warningEmbed] }).catch(() => {});

      if (warnings.count >= 3) {
        const muted = await handleMute(message.member, 60);
        if (muted) {
          client.userWarnings.delete(message.author.id);
          const deleteWarningsStmt = client.db.prepare('DELETE FROM warnings WHERE userId = ?');
          deleteWarningsStmt.run(message.author.id);
        }
      }
    }

    // Vérifier les mots inappropriés
    if (checkInappropriateWords(message)) {
      await message.delete();
      let warnings = client.userWarnings.get(message.author.id) || { count: 0, timestamps: [] };
      warnings.count++;
      warnings.timestamps.push(Date.now());
      client.userWarnings.set(message.author.id, warnings);

      const warningStmt = client.db.prepare('INSERT INTO warnings (userId, timestamp, reason) VALUES (?, ?, ?)');
      warningStmt.run(message.author.id, Date.now(), 'Mot inapproprié');

      const warningEmbed = createEmbed(
        t('fr', 'warning_title'),
        t('fr', 'warning_desc', { reason: 'Mot inapproprié' }),
        '#FF0000'
      );

      await message.author.send({ embeds: [warningEmbed] }).catch(() => {});

      if (warnings.count >= 3) {
        const muted = await handleMute(message.member, 60);
        if (muted) {
          client.userWarnings.delete(message.author.id);
          const deleteWarningsStmt = client.db.prepare('DELETE FROM warnings WHERE userId = ?');
          deleteWarningsStmt.run(message.author.id);
        }
      }
    }
  } catch (error) {
    logger.error(`Erreur messageCreate : ${error.message}`);
  }
});

// Planifier un giveaway hebdomadaire
function scheduleWeeklyGiveaway() {
  schedule.scheduleJob('0 0 * * 0', async () => {
    try {
      const channel = client.channels.cache.get(config.giveawayAnnouncementChannelId);
      if (!channel) return logger.error('Canal de giveaway non trouvé');

      const giveawayId = Date.now().toString();
      const prize = t('fr', 'gcreate_weekly_prize', { prize: 'Récompense Hebdomadaire' });
      const winnersCount = 1;
      const durationMinutes = 10080; // 1 semaine
      const participants = new Set();
      client.giveawayParticipants.set(giveawayId, participants);

      const embed = createEmbed(
        t('fr', 'gcreate_weekly_title'),
        t('fr', 'gcreate_desc_text', {
          condition: t('fr', 'gcreate_weekly_condition'),
          prize,
          winners: winnersCount,
          participants: 0,
          minutes: durationMinutes,
          seconds: 0
        }),
        '#FF5733'
      );

      const participateButton = new ButtonBuilder()
        .setCustomId(`participate_${giveawayId}`)
        .setLabel(t('fr', 'gcreate_participate_button'))
        .setStyle(ButtonStyle.Success);

      const message = await channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(participateButton)]
      });

      const endTime = Date.now() + durationMinutes * 60 * 1000;
      client.activeGiveaways.set(giveawayId, {
        messageId: message.id,
        channelId: channel.id,
        prize,
        winnersCount,
        participants,
        endTime
      });

      const giveawayStmt = client.db.prepare('INSERT INTO giveaways (giveawayId, messageId, channelId, prize, winnersCount, endTime) VALUES (?, ?, ?, ?, ?, ?)');
      giveawayStmt.run(giveawayId, message.id, channel.id, prize, winnersCount, endTime);

      scheduleGiveawayCountdown(giveawayId, durationMinutes * 60, t('fr', 'gcreate_weekly_condition'), prize, winnersCount, message, participateButton);
    } catch (error) {
      logger.error(`Erreur scheduleWeeklyGiveaway : ${error.message}`);
    }
  });
}

// Planifier une quête quotidienne
function scheduleDailyQuest() {
  schedule.scheduleJob('0 0 * * *', async () => {
    try {
      const channel = client.channels.cache.get(config.dailyQuestChannelId);
      if (!channel) return logger.error('Canal de quêtes quotidiennes non trouvé');

      const deleteStmt = client.db.prepare('DELETE FROM quests WHERE endTime <= ?');
      deleteStmt.run(Date.now());

      const questId = Date.now().toString();
      const objective = 'Envoyer 10 messages';
      const reward = '50 XP';
      const durationMinutes = 1440; // 24h
      const endTime = Date.now() + durationMinutes * 60 * 1000;

      const embed = createEmbed(
        t('fr', 'quest_title'),
        t('fr', 'quest_desc', { objective, reward, minutes: durationMinutes }),
        '#FFD700'
      );

      const participateButton = new ButtonBuilder()
        .setCustomId(`quest_participate_${questId}`)
        .setLabel(t('fr', 'quest_participate_button', { objective }))
        .setStyle(ButtonStyle.Success);

      const message = await channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(participateButton)]
      });

      const questStmt = client.db.prepare('INSERT INTO quests (questId, objective, reward, endTime, progress, total) VALUES (?, ?, ?, ?, ?, ?)');
      questStmt.run(questId, objective, reward, endTime, 0, 10);

      client.questParticipants.set(questId, new Set());
      logger.info(t('fr', 'quest_success'));
    } catch (error) {
      logger.error(`Erreur scheduleDailyQuest : ${error.message}`);
    }
  });
}

// Planifier le compte à rebours des giveaways
function scheduleGiveawayCountdown(giveawayId, remainingTime, condition, prize, winnersCount, message, participateButton) {
  const interval = setInterval(async () => {
    try {
      if (remainingTime <= 0) {
        clearInterval(interval);
        const giveaway = client.activeGiveaways.get(giveawayId);
        if (!giveaway) return;

        const participantsArray = Array.from(giveaway.participants);
        const winners = participantsArray.sort(() => Math.random() - 0.5).slice(0, giveaway.winnersCount);
        const winnerText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : t('fr', 'gcreate_no_winners');

        const endEmbed = createEmbed(
          t('fr', 'gcreate_winner_title'),
          t('fr', 'gcreate_winner_desc', { winners: winnerText, prize: giveaway.prize }),
          '#FF0000'
        );

        const channel = client.channels.cache.get(giveaway.channelId);
        await channel.send({
          content: winners.length > 0 ? t('fr', 'gcreate_winner_content', { winners: winnerText, prize: giveaway.prize }) : t('fr', 'gcreate_no_winners_content'),
          embeds: [endEmbed]
        });

        await message.edit({
          components: [new ActionRowBuilder().addComponents(
            participateButton.setLabel(t('fr', 'gcreate_ended_button')).setDisabled(true)
          )]
        });

        client.activeGiveaways.delete(giveawayId);
        client.giveawayParticipants.delete(giveawayId);
        const deleteStmt = client.db.prepare('DELETE FROM giveaways WHERE giveawayId = ?');
        deleteStmt.run(giveawayId);
      } else {
        const minutes = Math.floor(remainingTime / 60);
        const seconds = remainingTime % 60;
        const participants = client.giveawayParticipants.get(giveawayId);
        const embed = createEmbed(
          t('fr', 'gcreate_title'),
          t('fr', 'gcreate_desc_text', {
            condition,
            prize,
            winners: winnersCount,
            participants: participants ? participants.size : 0,
            minutes,
            seconds
          }),
          '#FF5733'
        );
        await message.edit({ embeds: [embed] });
        remainingTime--;
      }
    } catch (error) {
      logger.error(`Erreur countdown giveaway ${giveawayId} : ${error.message}`);
    }
  }, 1000);
}

// Planifier la progression des quêtes
function scheduleQuestProgress() {
  schedule.scheduleJob('0 * * * *', async () => {
    try {
      const questStmt = client.db.prepare('SELECT * FROM quests WHERE endTime > ?');
      const quests = questStmt.all(Date.now());
      for (const quest of quests) {
        if (quest.progress < quest.total) {
          const newProgress = quest.progress + 1;
          const updateStmt = client.db.prepare('UPDATE quests SET progress = ? WHERE questId = ?');
          updateStmt.run(newProgress, quest.questId);
          if (newProgress >= quest.total) {
            const channel = client.channels.cache.get(config.dailyQuestChannelId);
            if (channel) {
              const embed = createEmbed(
                t('fr', 'quest_ended_title'),
                t('fr', 'quest_ended_desc', { objective: quest.objective, reward: quest.reward }),
                '#00FF00'
              );
              await channel.send({ embeds: [embed] });
              const participants = client.questParticipants.get(quest.questId) || new Set();
              for (const userId of participants) {
                await addXP(userId, parseInt(quest.reward) || 50);
              }
            }
            const deleteStmt = client.db.prepare('DELETE FROM quests WHERE questId = ?');
            deleteStmt.run(quest.questId);
            client.questParticipants.delete(quest.questId);
          }
        }
      }
    } catch (error) {
      logger.error(`Erreur scheduleQuestProgress : ${error.message}`);
    }
  });
}

// Planifier l'expiration des polls
function schedulePollExpirations() {
  schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const pollStmt = client.db.prepare('SELECT * FROM polls WHERE endTime <= ?');
      const polls = pollStmt.all(Date.now());
      for (const poll of polls) {
        const pollData = client.activePolls.get(poll.pollId);
        if (!pollData) continue;

        const channel = client.channels.cache.get(pollData.channelId);
        const finalEmbed = createEmbed(
          t('fr', 'poll_ended_title', { question: pollData.question }),
          pollData.options.map((opt, i) => `${i + 1}. ${opt} (${pollData.votes[i]} votes)`).join('\n'),
          '#FF0000'
        );

        const message = await channel.messages.fetch(pollData.messageId).catch(() => null);
        if (message) {
          await message.edit({ embeds: [finalEmbed], components: [] });
        }

        client.activePolls.delete(poll.pollId);
        const deleteStmt = client.db.prepare('DELETE FROM polls WHERE pollId = ?');
        deleteStmt.run(poll.pollId);
      }
    } catch (error) {
      logger.error(`Erreur schedulePollExpirations : ${error.message}`);
    }
  });
}

// Planifier les rappels d'événements
function scheduleEventReminders() {
  schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const eventStmt = client.db.prepare('SELECT * FROM events WHERE date <= ?');
      const events = eventStmt.all(Date.now());
      for (const event of events) {
        const channel = client.channels.cache.get(event.channelId);
        const embed = createEmbed(
          t('fr', 'event_title', { title: event.title }),
          t('fr', 'event_desc', { description: event.description, date: new Date(event.date).toLocaleString() }),
          '#FFD700'
        );

        await channel.send({
          content: t('fr', 'event_reminder', { title: event.title }),
          embeds: [embed]
        });

        const deleteStmt = client.db.prepare('DELETE FROM events WHERE eventId = ?');
        deleteStmt.run(event.eventId);
        client.eventParticipants.delete(event.eventId);
      }
    } catch (error) {
      logger.error(`Erreur scheduleEventReminders : ${error.message}`);
    }
  });
}

// Fermer la base de données à la sortie du processus
process.on('SIGINT', () => {
  client.db.close((err) => {
    if (err) logger.error(`Erreur lors de la fermeture de la base de données : ${err.message}`);
    logger.info('Base de données fermée.');
    process.exit(0);
  });
});

// Connexion à Discord
client.login(config.botToken).catch(error => {
  logger.error(`Erreur login : ${error.message}`);
});