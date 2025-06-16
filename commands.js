const {
  SlashCommandBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  InteractionResponseFlags
} = require('discord.js');
const winston = require('winston');
const { fetchWeather } = require('./utils/weather');
const fetch = require('node-fetch');

// Configuration du logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Charger les fichiers de traduction
const translations = {
  fr: require('/home/container/lang/fr.json'),
  'en-US': require('/home/container/lang/en-US.json')
};

// Fonction pour obtenir une traduction avec des placeholders
function t(lang, key, placeholders = {}) {
  let message = translations[lang]?.[key] || translations.fr[key] || key;
  for (const [k, v] of Object.entries(placeholders)) {
    message = message.replace(`{{${k}}}`, v);
  }
  return message;
}

// Configuration
const config = require('./config.json');

// Cooldown management
const cooldowns = new Map();

function applyCooldown(interaction, commandName, cooldownSeconds) {
  const userId = interaction.user.id;
  const now = Date.now();
  const key = `${userId}-${commandName}`;

  if (!cooldowns.has(key)) {
    cooldowns.set(key, now);
    return true;
  }

  const lastUsed = cooldowns.get(key);
  const timeLeft = (lastUsed + cooldownSeconds * 1000 - now) / 1000;

  if (timeLeft > 0) {
    interaction.reply({
      content: t(interaction.locale.startsWith('fr') ? 'fr' : 'en-US', 'cooldown', { remaining: timeLeft.toFixed(1) }),
      flags: InteractionResponseFlags.Ephemeral
    });
    return false;
  }

  cooldowns.set(key, now);
  return true;
}

// Permission check
function checkPermissions(interaction, permission) {
  if (!interaction.member.permissions.has(permission)) {
    interaction.reply({
      content: t(interaction.locale.startsWith('fr') ? 'fr' : 'en-US', 'no_permission'),
      flags: InteractionResponseFlags.Ephemeral
    });
    return false;
  }
  return true;
}

// Embed creation utility
function createEmbed(title, description, color = '#FFD700', options = {}) {
  const { footerText = config.botName, footerIcon = config.botAvatar, thumbnail, image, fields = [], timestamp = true } = options;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description ? `**${description}**` : null)
    .setColor(color)
    .setFooter({ text: footerText, iconURL: footerIcon });

  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);
  if (fields.length) embed.addFields(fields);
  if (timestamp) embed.setTimestamp();

  return embed;
}

// Liste des commandes slash
const commands = [
  // Commande ping
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription(t('fr', 'ping_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'ping_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'ping', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const sent = await interaction.reply({ content: t(lang, 'ping_calculating'), fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;

      const embed = createEmbed(
        '📊 ' + t(lang, 'ping_title'),
        null,
        '#FFD700',
        {
          thumbnail: config.botThumbnail,
          fields: [
            { name: '<a:Three_Points_Animated:1260007513122799778> ' + t(lang, 'ping_api'), value: `\`${Math.round(interaction.client.ws.ping)} ms\``, inline: true },
            { name: '<a:Three_Points_Animated:1260007513122799778> ' + t(lang, 'ping_bot'), value: `\`${latency} ms\``, inline: true }
          ]
        }
      );

      await interaction.editReply({ content: null, embeds: [embed] });
    }
  },
  // Commande clear
  {
    data: new SlashCommandBuilder()
      .setName('clear')
      .setDescription(t('fr', 'clear_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'clear_desc') })
      .addIntegerOption(option =>
        option
          .setName('nombre')
          .setDescription(t('fr', 'clear_amount_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'clear_amount_desc') })
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageMessages)) return;
      if (!applyCooldown(interaction, 'clear', 10)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const amount = interaction.options.getInteger('nombre');

      if (amount < 1 || amount > 100) {
        return interaction.reply({ content: t(lang, 'clear_invalid_amount'), flags: InteractionResponseFlags.Ephemeral });
      }

      try {
        await interaction.channel.bulkDelete(amount, true);
        const embed = createEmbed(
          '🗑️ ' + t(lang, 'clear_success_title'),
          t(lang, 'clear_success_desc', { amount }),
          '#FFD700'
        );

        await interaction.reply({ embeds: [embed], flags: InteractionResponseFlags.Ephemeral });

        const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
        if (logChannel) {
          const logEmbed = createEmbed(
            t(lang, 'log_clear_title'),
            t(lang, 'log_clear_desc', {
              moderator: interaction.user.tag,
              channel: interaction.channel.toString(),
              amount
            }),
            '#FF0000'
          );
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (error) {
        logger.error(`Erreur lors de la suppression des messages : ${error.message}`);
        return interaction.reply({ content: t(lang, 'clear_error'), flags: InteractionResponseFlags.Ephemeral });
      }
    }
  },
  // Commande lock
  {
    data: new SlashCommandBuilder()
      .setName('lock')
      .setDescription(t('fr', 'lock_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'lock_desc') })
      .addChannelOption(option =>
        option
          .setName('salon')
          .setDescription(t('fr', 'lock_channel_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'lock_channel_desc') })
          .setRequired(true)
      )
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription(t('fr', 'lock_role_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'lock_role_desc') })
          .setRequired(true)
      )
      .addBooleanOption(option =>
        option
          .setName('verrouiller')
          .setDescription(t('fr', 'lock_action_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'lock_action_desc') })
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageChannels)) return;
      if (!applyCooldown(interaction, 'lock', 10)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const channel = interaction.options.getChannel('salon');
      const role = interaction.options.getRole('role');
      const lock = interaction.options.getBoolean('verrouiller');

      try {
        await channel.permissionOverwrites.edit(role, {
          SendMessages: !lock,
          ViewChannel: true
        });

        const status = lock ? t(lang, 'lock_locked') : t(lang, 'lock_unlocked');
        const embed = createEmbed(
          '🔒 ' + t(lang, 'lock_title', { status }),
          t(lang, 'lock_desc_success', { channel: channel.name, status, role: role.name }),
          lock ? '#FF5733' : '#00FF00'
        );

        await interaction.reply({ embeds: [embed], flags: InteractionResponseFlags.Ephemeral });

        const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
        if (logChannel) {
          const logEmbed = createEmbed(
            t(lang, 'log_lock_title', { status }),
            t(lang, 'log_lock_desc', {
              moderator: interaction.user.tag,
              channel: channel.toString(),
              role: role.toString(),
              status
            }),
            lock ? '#FF0000' : '#00FF00'
          );
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (error) {
        logger.error(`Erreur lors du verrouillage du salon : ${error.message}`);
        await interaction.reply({ content: t(lang, 'lock_error'), flags: InteractionResponseFlags.Ephemeral });
      }
    }
  },
  // Commande infoserveur
  {
    data: new SlashCommandBuilder()
      .setName('infoserveur')
      .setDescription(t('fr', 'infoserveur_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'infoserveur_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'infoserveur', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const guild = interaction.guild;
      const owner = await guild.fetchOwner();

      const embed = createEmbed(
        t(lang, 'infoserveur_title', { name: guild.name }),
        null,
        '#FFD700',
        {
          thumbnail: guild.iconURL({ dynamic: true }) || config.botThumbnail,
          fields: [
            { name: '<a:Crown:1259591630344687647> ' + t(lang, 'infoserveur_owner'), value: owner.user.tag, inline: true },
            { name: '<a:animatedeyes:1259610896901079050> ' + t(lang, 'infoserveur_created'), value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true },
            { name: '<a:Boostanimated:1260007456357224540> ' + t(lang, 'infoserveur_members'), value: `${guild.memberCount}`, inline: true },
            { name: '<a:computerbasicanimated:1259611140598534196> ' + t(lang, 'infoserveur_channels'), value: `${guild.channels.cache.size}`, inline: true },
            { name: '<a:fire_animated:1260007187930153031> ' + t(lang, 'infoserveur_roles'), value: `${guild.roles.cache.size}`, inline: true },
            { name: '<a:trollanimated:1259607909315248169> ' + t(lang, 'infoserveur_emojis'), value: `${guild.emojis.cache.size}`, inline: true }
          ],
          footerText: t(lang, 'infoserveur_footer', { id: guild.id })
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande info-vodsalert
  {
    data: new SlashCommandBuilder()
      .setName('info-vodsalert')
      .setDescription(t('fr', 'info_vodsalert_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'info_vodsalert_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'info-vodsalert', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const embed = createEmbed(
        t(lang, 'info_vodsalert_title'),
        t(lang, 'info_vodsalert_desc_text'),
        '#FFD700',
        {
          thumbnail: config.botThumbnail,
          fields: [
            { name: t(lang, 'info_vodsalert_version'), value: '2.0.0', inline: true },
            { name: t(lang, 'info_vodsalert_developer'), value: 'VodsMoney', inline: true },
            { name: t(lang, 'info_vodsalert_features'), value: t(lang, 'info_vodsalert_features_list'), inline: false }
          ]
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande annonce
  {
    data: new SlashCommandBuilder()
      .setName('annonce')
      .setDescription(t('fr', 'annonce_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'annonce_desc') })
      .addStringOption(option =>
        option
          .setName('schedule')
          .setDescription(t('fr', 'annonce_schedule_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'annonce_schedule_desc') })
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageGuild)) return;
      if (!applyCooldown(interaction, 'annonce', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const schedule = interaction.options.getString('schedule') || 'immediate';
      const modal = new ModalBuilder()
        .setCustomId(`annonceModal_${schedule}`)
        .setTitle(t(lang, 'annonce_modal_title'));

      const inputs = [
        { id: 'typeAnnonce', label: t(lang, 'annonce_type_label'), style: TextInputStyle.Short, required: true },
        { id: 'communityBenefit', label: t(lang, 'annonce_benefit_label'), style: TextInputStyle.Paragraph, required: true },
        { id: 'goodNews', label: t(lang, 'annonce_news_label'), style: TextInputStyle.Paragraph, required: true },
        { id: 'roleMention', label: t(lang, 'annonce_role_label'), style: TextInputStyle.Short, required: true },
        { id: 'attachmentUrl', label: t(lang, 'annonce_attachment_label'), style: TextInputStyle.Short, required: false }
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

      const filter = i => i.customId === `annonceModal_${schedule}` && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const type = modalInteraction.fields.getTextInputValue('typeAnnonce');
          const benefit = modalInteraction.fields.getTextInputValue('communityBenefit');
          const news = modalInteraction.fields.getTextInputValue('goodNews');
          const roleId = modalInteraction.fields.getTextInputValue('roleMention').match(/\d+/)?.[0];
          const attachment = modalInteraction.fields.getTextInputValue('attachmentUrl') || null;

          if (roleId && config.forbiddenMentions.roles.includes(roleId)) {
            return modalInteraction.reply({
              content: t(lang, 'annonce_forbidden_role'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const channel = interaction.guild.channels.cache.get(config.announcementChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'annonce_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const embed = createEmbed(
            t(lang, 'annonce_title', { type }),
            t(lang, 'annonce_desc', { benefit, news, role: roleId ? `<@&${roleId}>` : 'Aucun rôle' }),
            '#FFD700',
            { image: attachment }
          );

          const message = await channel.send({ content: roleId ? `<@&${roleId}>` : null, embeds: [embed] });
          await modalInteraction.reply({
            content: t(lang, 'annonce_success'),
            flags: InteractionResponseFlags.Ephemeral
          });

          const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
          if (logChannel) {
            const logEmbed = createEmbed(
              t(lang, 'log_annonce_title'),
              t(lang, 'log_annonce_desc', {
                moderator: interaction.user.tag,
                channel: channel.toString(),
                type
              }),
              '#FF0000'
            );
            await logChannel.send({ embeds: [logEmbed] });
          }
        })
        .catch(error => {
          logger.error(`Erreur modal annonce : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande gcreate
  {
    data: new SlashCommandBuilder()
      .setName('gcreate')
      .setDescription(t('fr', 'gcreate_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'gcreate_desc') })
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageGuild)) return;
      if (!applyCooldown(interaction, 'gcreate', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('giveawayModal')
        .setTitle(t(lang, 'gcreate_modal_title'));

      const inputs = [
        { id: 'condition', label: t(lang, 'gcreate_condition_label'), style: TextInputStyle.Paragraph, required: false },
        { id: 'prize', label: t(lang, 'gcreate_prize_label'), style: TextInputStyle.Short, required: true },
        { id: 'duration', label: t(lang, 'gcreate_duration_label'), style: TextInputStyle.Short, required: true },
        { id: 'winners', label: t(lang, 'gcreate_winners_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'giveawayModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const condition = modalInteraction.fields.getTextInputValue('condition') || 'Aucune';
          const prize = modalInteraction.fields.getTextInputValue('prize');
          const duration = parseInt(modalInteraction.fields.getTextInputValue('duration'));
          const winners = parseInt(modalInteraction.fields.getTextInputValue('winners'));

          if (isNaN(duration) || duration <= 0 || isNaN(winners) || winners <= 0) {
            return modalInteraction.reply({
              content: t(lang, 'interaction_error') + ': **Durée ou nombre de gagnants invalide**',
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const giveawayId = Date.now().toString();
          const channel = interaction.guild.channels.cache.get(config.giveawayAnnouncementChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'gcreate_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const endTime = Date.now() + duration * 60 * 1000;
          const embed = createEmbed(
            t(lang, 'gcreate_title'),
            t(lang, 'gcreate_desc', { prize, winners, condition, endTime: `<t:${Math.floor(endTime / 1000)}:R>` }),
            '#FFD700'
          );

          const participateButton = new ButtonBuilder()
            .setCustomId(`giveaway_participate_${giveawayId}`)
            .setLabel(t(lang, 'gcreate_participate_button'))
            .setStyle(ButtonStyle.Primary);

          const message = await channel.send({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(participateButton)]
          });

          interaction.client.db.prepare('INSERT INTO giveaways (giveawayId, messageId, channelId, prize, winnersCount, endTime, condition) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(giveawayId, message.id, channel.id, prize, winners, endTime, condition);

          await modalInteraction.reply({
            content: t(lang, 'gcreate_success'),
            flags: InteractionResponseFlags.Ephemeral
          });
        })
        .catch(error => {
          logger.error(`Erreur modal gcreate : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande clear-dm
  {
    data: new SlashCommandBuilder()
      .setName('clear-dm')
      .setDescription(t('fr', 'clear_dm_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'clear_dm_desc') })
      .addUserOption(option =>
        option
          .setName('utilisateur')
          .setDescription(t('fr', 'clear_dm_user_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'clear_dm_user_desc') })
          .setRequired(false)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'clear-dm', 30)) return;
      await interaction.deferReply({ flags: InteractionResponseFlags.Ephemeral });

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const targetUser = interaction.options.getUser('utilisateur') || interaction.user;
      if (targetUser.id !== interaction.user.id && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return await interaction.editReply({ content: t(lang, 'clear_dm_no_permission') });
      }

      try {
        const dmChannel = await targetUser.createDM();
        const messages = await dmChannel.messages.fetch({ limit: 100 });
        let deletedCount = 0;
        let failedCount = 0;

        for (const message of messages.values()) {
          if (message.author.id === interaction.client.user.id || message.author.id === targetUser.id) {
            try {
              await message.delete();
              deletedCount++;
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (deleteError) {
              failedCount++;
              logger.error(`Erreur lors de la suppression du message ${message.id} : ${deleteError.message}`);
            }
          }
        }

        let replyMessage = deletedCount > 0
          ? t(lang, 'clear_dm_success', { count: deletedCount, user: targetUser.tag })
          : t(lang, 'clear_dm_no_messages', { user: targetUser.tag });
        if (failedCount > 0) {
          replyMessage += t(lang, 'clear_dm_failed', { count: failedCount });
        }

        await interaction.editReply({ content: replyMessage });
      } catch (error) {
        if (error.code === 50007) {
          await interaction.editReply({ content: t(lang, 'clear_dm_access_denied') });
        } else {
          logger.error(`Erreur clear-dm : ${error.message}`);
          await interaction.editReply({ content: t(lang, 'clear_dm_error') });
        }
      }
    }
  },
  // Commande ticket
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription(t('fr', 'ticket_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'ticket_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'ticket', 60)) return;
      await interaction.deferReply({ flags: InteractionResponseFlags.Ephemeral });

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      try {
        const ticketChannel = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.username}`,
          type: ChannelType.GuildText,
          parent: config.ticketCategoryId,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            ...config.authorizedRoles.map(roleId => ({
              id: roleId,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            }))
          ]
        });

        const welcomeEmbed = createEmbed(
          t(lang, 'ticket_welcome_title', { guild: interaction.guild.name }),
          t(lang, 'ticket_welcome_desc', { user: interaction.user.toString() }) + '\n```🔒 ' + t(lang, 'ticket_rules_reminder') + '```',
          0x6A0DAD
        );

        const createTicketButton = new ButtonBuilder()
          .setCustomId('openTicketModal')
          .setLabel(t(lang, 'ticket_create_button'))
          .setEmoji('🎫')
          .setStyle(ButtonStyle.Success);

        const closeButton = new ButtonBuilder()
          .setCustomId('close-ticket')
          .setLabel(t(lang, 'ticket_close_button'))
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(createTicketButton, closeButton);

        await ticketChannel.send({
          embeds: [welcomeEmbed],
          components: [row]
        });

        await interaction.editReply({
          content: t(lang, 'ticket_success', { channel: ticketChannel.toString() })
        });

        const filter = i => i.customId === 'openTicketModal' && i.user.id === interaction.user.id;
        const collector = ticketChannel.createMessageComponentCollector({ filter, time: 86400000 });

        collector.on('collect', async i => {
          const modal = new ModalBuilder()
            .setCustomId('ticketFeedbackModal')
            .setTitle(t(lang, 'ticket_modal_title'));

          const feedbackInput = new TextInputBuilder()
            .setCustomId('feedback')
            .setLabel(t(lang, 'ticket_feedback_label'))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

          modal.addComponents(new ActionRowBuilder().addComponents(feedbackInput));
          await i.showModal(modal);
        });

        const modalFilter = i => i.customId === 'ticketFeedbackModal' && i.user.id === interaction.user.id;
        interaction.awaitModalSubmit({ filter: modalFilter, time: 86400000 })
          .then(async modalInteraction => {
            const feedback = modalInteraction.fields.getTextInputValue('feedback');
            const feedbackEmbed = createEmbed(
              t(lang, 'ticket_feedback_title'),
              t(lang, 'ticket_feedback_desc', { user: modalInteraction.user.tag, feedback }),
              0x6A0DAD
            );

            await modalInteraction.reply({ embeds: [feedbackEmbed] });
            const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
            if (logChannel) {
              await logChannel.send({ embeds: [feedbackEmbed] });
            }
          })
          .catch(error => {
            logger.error(`Erreur modal ticket : ${error.message}`);
          });
      } catch (error) {
        logger.error(`Erreur lors de la création du ticket : ${error.message}`);
        await interaction.editReply({ content: t(lang, 'interaction_error') });
      }
    }
  },
  // Commande updaterules
  {
    data: new SlashCommandBuilder()
      .setName('updaterules')
      .setDescription(t('fr', 'updaterules_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'updaterules_desc') })
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.Administrator)) return;
      if (!applyCooldown(interaction, 'updaterules', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('updateRulesModal')
        .setTitle(t(lang, 'updaterules_modal_title'));

      const rulesInput = new TextInputBuilder()
        .setCustomId('rulesText')
        .setLabel(t(lang, 'updaterules_rules_label'))
        .setStyle(TextInputStyle.Paragraph)
        .setValue(t(lang, 'rules_desc'));

      modal.addComponents(new ActionRowBuilder().addComponents(rulesInput));
      await interaction.showModal(modal);

      const filter = i => i.customId === 'updateRulesModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const rules = modalInteraction.fields.getTextInputValue('rulesText');
          const channel = interaction.guild.channels.cache.get(config.rulesChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'updaterules_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const embed = createEmbed(
            t(lang, 'updaterules_title'),
            rules,
            '#FFD700'
          );

          await channel.send({ embeds: [embed] });
          await modalInteraction.reply({
            content: t(lang, 'updaterules_success'),
            flags: InteractionResponseFlags.Ephemeral
          });
        })
        .catch(error => {
          logger.error(`Erreur modal updaterules : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande userinfo
  {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription(t('fr', 'userinfo_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'userinfo_desc') })
      .addUserOption(option =>
        option
          .setName('utilisateur')
          .setDescription(t('fr', 'userinfo_user_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'userinfo_user_desc') })
          .setRequired(false)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'userinfo', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const targetUser = interaction.options.getUser('utilisateur') || interaction.user;
      const member = await interaction.guild.members.fetch(targetUser.id);

      const embed = createEmbed(
        t(lang, 'userinfo_title', { username: targetUser.username }),
        null,
        '#FFD700',
        {
          thumbnail: targetUser.displayAvatarURL({ dynamic: true }),
          fields: [
            { name: t(lang, 'userinfo_id'), value: targetUser.id, inline: true },
            { name: t(lang, 'userinfo_created'), value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`, inline: true },
            { name: t(lang, 'userinfo_joined'), value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: true },
            { name: t(lang, 'userinfo_roles'), value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.toString()).join(', ') || 'Aucun', inline: false }
          ]
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande roleinfo
  {
    data: new SlashCommandBuilder()
      .setName('roleinfo')
      .setDescription(t('fr', 'roleinfo_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'roleinfo_desc') })
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription(t('fr', 'roleinfo_role_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'roleinfo_role_desc') })
          .setRequired(true)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'roleinfo', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const role = interaction.options.getRole('role');
      const embed = createEmbed(
        t(lang, 'roleinfo_title', { name: role.name }),
        null,
        role.hexColor,
        {
          fields: [
            { name: t(lang, 'roleinfo_id'), value: role.id, inline: true },
            { name: t(lang, 'roleinfo_created'), value: `<t:${Math.floor(role.createdTimestamp / 1000)}:F>`, inline: true },
            { name: t(lang, 'roleinfo_members'), value: `${role.members.size}`, inline: true },
            { name: t(lang, 'roleinfo_permissions'), value: role.permissions.toArray().join(', ') || 'Aucune', inline: false }
          ]
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande avatar
  {
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription(t('fr', 'avatar_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'avatar_desc') })
      .addUserOption(option =>
        option
          .setName('utilisateur')
          .setDescription(t('fr', 'avatar_user_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'avatar_user_desc') })
          .setRequired(false)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'avatar', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const targetUser = interaction.options.getUser('utilisateur') || interaction.user;
      const embed = createEmbed(
        t(lang, 'avatar_title', { username: targetUser.username }),
        null,
        '#FFD700',
        {
          image: targetUser.displayAvatarURL({ dynamic: true, size: 512 })
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande weather
  {
    data: new SlashCommandBuilder()
      .setName('weather')
      .setDescription(t('fr', 'weather_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'weather_desc') })
      .addStringOption(option =>
        option
          .setName('ville')
          .setDescription(t('fr', 'weather_city_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'weather_city_desc') })
          .setRequired(true)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'weather', 10)) return;
      await interaction.deferReply();

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const city = interaction.options.getString('ville');
      const weatherData = await fetchWeather(city, lang, config.weatherApiKey);

      if (weatherData.error) {
        return interaction.editReply({
          content: `**${weatherData.error}**`,
          flags: InteractionResponseFlags.Ephemeral
        });
      }

      const embed = createEmbed(
        t(lang, 'weather_title', { city: weatherData.name }),
        t(lang, 'weather_desc_text', {
          temp: weatherData.temp,
          feels: weatherData.feels_like,
          weather: weatherData.description,
          humidity: weatherData.humidity,
          wind: weatherData.wind_speed
        }),
        '#FFD700',
        {
          thumbnail: `http://openweathermap.org/img/wn/${weatherData.icon}@2x.png`
        }
      );

      await interaction.editReply({ embeds: [embed] });
    }
  },
  // Commande stats
  {
    data: new SlashCommandBuilder()
      .setName('stats')
      .setDescription(t('fr', 'stats_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'stats_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'stats', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const guild = interaction.guild;

      const stmtMessages = interaction.client.db.prepare('SELECT COUNT(*) as count FROM messages WHERE date = ?');
      const messagesToday = stmtMessages.get(new Date().toISOString().split('T')[0])?.count || 0;

      const stmtTopUsers = interaction.client.db.prepare('SELECT userId, COUNT(*) as count FROM messages WHERE date = ? GROUP BY userId ORDER BY count DESC LIMIT 5');
      const topUsers = stmtTopUsers.all(new Date().toISOString().split('T')[0]) || [];

      const embed = createEmbed(
        t(lang, 'stats_title', { guild: guild.name }),
        t(lang, 'stats_desc_text', {
          members: guild.memberCount,
          messages: messagesToday
        }),
        '#FFD700',
        {
          fields: [
            {
              name: t(lang, 'stats_top_users'),
              value: topUsers.length ? topUsers.map(u => `<@${u.userId}>: ${u.count} messages`).join('\n') : t(lang, 'stats_no_data'),
              inline: false
            }
          ]
        }
      );

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande suggest
  {
    data: new SlashCommandBuilder()
      .setName('suggest')
      .setDescription(t('fr', 'suggest_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'suggest_desc') })
      .addStringOption(option =>
        option
          .setName('suggestion')
          .setDescription(t('fr', 'suggest_suggestion_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'suggest_suggestion_desc') })
          .setRequired(true)
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'suggest', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const suggestion = interaction.options.getString('suggestion');
      const suggestionChannel = interaction.guild.channels.cache.get(config.suggestionChannelId);

      if (!suggestionChannel) {
        return interaction.reply({ content: t(lang, 'suggest_no_channel'), flags: InteractionResponseFlags.Ephemeral });
      }

      const embed = createEmbed(
        '💡 ' + t(lang, 'suggest_title'),
        t(lang, 'suggest_desc_text', { user: interaction.user.tag, suggestion }),
        '#FFD700'
      );

      const message = await suggestionChannel.send({ embeds: [embed] });
      await message.react('👍');
      await message.react('👎');

      await interaction.reply({ content: t(lang, 'suggest_success'), flags: InteractionResponseFlags.Ephemeral });
    }
  },
  // Commande help
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription(t('fr', 'help_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'help_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'help', 5)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const embed = createEmbed(
        t(lang, 'help_title'),
        t(lang, 'help_desc_text'),
        '#FFD700',
        {
          fields: commands.map(cmd => ({
            name: `/${cmd.data.name}`,
            value: `${cmd.data.description}\n**Permissions:** ${cmd.data.defaultMemberPermissions?.bitfield ? new PermissionsBitField(cmd.data.defaultMemberPermissions).toArray().join(', ') : 'Aucune'}`,
            inline: false
          }))
        }
      );

      await interaction.reply({ embeds: [embed], flags: InteractionResponseFlags.Ephemeral });
    }
  },
  // Commande poll
  {
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription(t('fr', 'poll_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'poll_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'poll', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('pollModal')
        .setTitle(t(lang, 'poll_modal_title'));

      const inputs = [
        { id: 'question', label: t(lang, 'poll_question_label'), style: TextInputStyle.Short, required: true },
        { id: 'option1', label: t(lang, 'poll_option1_label'), style: TextInputStyle.Short, required: true },
        { id: 'option2', label: t(lang, 'poll_option2_label'), style: TextInputStyle.Short, required: true },
        { id: 'option3', label: t(lang, 'poll_option3_label'), style: TextInputStyle.Short, required: false },
        { id: 'duration', label: t(lang, 'poll_duration_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'pollModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const question = modalInteraction.fields.getTextInputValue('question');
          const option1 = modalInteraction.fields.getTextInputValue('option1');
          const option2 = modalInteraction.fields.getTextInputValue('option2');
          const option3 = modalInteraction.fields.getTextInputValue('option3') || null;
          const duration = parseInt(modalInteraction.fields.getTextInputValue('duration'));

          if (isNaN(duration) || duration <= 0) {
            return modalInteraction.reply({
              content: t(lang, 'interaction_error') + ': **Durée invalide**',
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const options = [option1, option2];
          if (option3) options.push(option3);
          const votes = new Array(options.length).fill(0);
          const pollId = Date.now().toString();
          const endTime = Date.now() + duration * 60 * 1000;

          const channel = interaction.guild.channels.cache.get(config.pollChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'poll_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const embed = createEmbed(
            t(lang, 'poll_title'),
            t(lang, 'poll_desc', { question, options: options.map((opt, i) => `${i + 1}. ${opt}`).join('\n'), endTime: `<t:${Math.floor(endTime / 1000)}:R>` }),
            '#FFD700'
          );

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`poll_vote_${pollId}`)
            .setPlaceholder(t(lang, 'poll_select_placeholder'))
            .addOptions(options.map((opt, i) => ({
              label: opt,
              value: i.toString()
            })));

          const message = await channel.send({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(selectMenu)]
          });

          interaction.client.db.prepare('INSERT INTO polls (pollId, messageId, channelId, question, options, votes, endTime) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(pollId, message.id, channel.id, question, JSON.stringify(options), JSON.stringify(votes), endTime);

          await modalInteraction.reply({
            content: t(lang, 'poll_success'),
            flags: InteractionResponseFlags.Ephemeral
          });
        })
        .catch(error => {
          logger.error(`Erreur modal poll : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande event
  {
    data: new SlashCommandBuilder()
      .setName('event')
      .setDescription(t('fr', 'event_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'event_desc') })
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageGuild)) return;
      if (!applyCooldown(interaction, 'event', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('eventModal')
        .setTitle(t(lang, 'event_modal_title'));

      const inputs = [
        { id: 'title', label: t(lang, 'event_title_label'), style: TextInputStyle.Short, required: true },
        { id: 'description', label: t(lang, 'event_description_label'), style: TextInputStyle.Paragraph, required: true },
        { id: 'date', label: t(lang, 'event_date_label'), style: TextInputStyle.Short, required: true },
        { id: 'role', label: t(lang, 'event_role_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'eventModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const title = modalInteraction.fields.getTextInputValue('title');
          const description = modalInteraction.fields.getTextInputValue('description');
          const dateStr = modalInteraction.fields.getTextInputValue('date');
          const roleId = modalInteraction.fields.getTextInputValue('role').match(/\d+/)?.[0];

          if (roleId && config.forbiddenMentions.roles.includes(roleId)) {
            return modalInteraction.reply({
              content: t(lang, 'event_forbidden_role'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const eventTime = Date.parse(dateStr);
          if (isNaN(eventTime) || eventTime < Date.now()) {
            return modalInteraction.reply({
              content: t(lang, 'interaction_error') + ': **Date invalide ou passée**',
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const eventId = Date.now().toString();
          const channel = interaction.guild.channels.cache.get(config.eventChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'event_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const embed = createEmbed(
            t(lang, 'event_title', { title }),
            t(lang, 'event_desc', { description, date: `<t:${Math.floor(eventTime / 1000)}:F>` }),
            '#FFD700'
          );

          const participateButton = new ButtonBuilder()
            .setCustomId(`event_participate_${eventId}`)
            .setLabel(t(lang, 'event_participate_button'))
            .setStyle(ButtonStyle.Primary);

          const message = await channel.send({
            content: roleId ? `<@&${roleId}>` : null,
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(participateButton)]
          });

          interaction.client.db.prepare('INSERT INTO events (eventId, messageId, channelId, title, description, date) VALUES (?, ?, ?, ?, ?, ?)')
            .run(eventId, message.id, channel.id, title, description, eventTime);

          await modalInteraction.reply({
            content: t(lang, 'event_success'),
            flags: InteractionResponseFlags.Ephemeral
          });
        })
        .catch(error => {
          logger.error(`Erreur modal event : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande achievement
  {
    data: new SlashCommandBuilder()
      .setName('achievement')
      .setDescription(t('fr', 'achievement_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'achievement_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'achievement', 10)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const stmt = interaction.client.db.prepare('SELECT achievements FROM profiles WHERE userId = ?');
      const profile = stmt.get(interaction.user.id) || { achievements: [] };

      const embed = createEmbed(
        t(lang, 'achievement_title', { username: interaction.user.username }),
        null,
        '#FFD700'
      );

      if (!profile.achievements || !Array.isArray(profile.achievements) || profile.achievements.length === 0) {
        embed.setDescription(t(lang, 'achievement_none'));
      } else {
        const achievements = profile.achievements.map(id => {
          const badge = config.achievementBadges[id];
          return badge ? `${badge.emoji} **${t(lang, badge.name)}**` : null;
        }).filter(Boolean).join('\n');
        embed.setDescription(achievements || t(lang, 'achievement_none'));
      }

      await interaction.reply({ embeds: [embed] });
    }
  },
  // Commande meme
  {
    data: new SlashCommandBuilder()
      .setName('meme')
      .setDescription(t('fr', 'meme_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'meme_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'meme', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('memeModal')
        .setTitle(t(lang, 'meme_modal_title'));

      const inputs = [
        { id: 'template', label: t(lang, 'meme_template_label'), style: TextInputStyle.Short, required: true },
        { id: 'topText', label: t(lang, 'meme_top_text_label'), style: TextInputStyle.Short, required: true },
        { id: 'bottomText', label: t(lang, 'meme_bottom_text_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'memeModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const template = modalInteraction.fields.getTextInputValue('template').toLowerCase();
          const topText = modalInteraction.fields.getTextInputValue('topText');
          const bottomText = modalInteraction.fields.getTextInputValue('bottomText');

          const templates = {
            'drake': '181913649',
            'distracted': '112126428',
            'spongebob': '102156234'
          };

          const templateId = templates[template] || '181913649';
          const apiUrl = `https://api.imgflip.com/caption_image?template_id=${templateId}&username=${config.imgflipUsername}&password=${config.imgflipPassword}&text0=${encodeURIComponent(topText)}&text1=${encodeURIComponent(bottomText)}`;

          try {
            const response = await fetch(apiUrl, { method: 'POST' });
            const data = await response.json();
            if (!data.success) {
              throw new Error(data.error_message || 'Erreur API Imgflip');
            }

            const embed = createEmbed(
              t(lang, 'meme_title'),
              t(lang, 'meme_desc', { user: interaction.user.tag }),
              '#FFD700',
              { image: data.data.url }
            );

            const channel = interaction.guild.channels.cache.get(config.memeChannelId);
            if (!channel) {
              return modalInteraction.reply({
                content: t(lang, 'meme_channel_not_found'),
                flags: InteractionResponseFlags.Ephemeral
              });
            }

            await channel.send({ embeds: [embed] });
            await modalInteraction.reply({
              content: t(lang, 'meme_success'),
              flags: InteractionResponseFlags.Ephemeral
            });
          } catch (error) {
            logger.error(`Erreur création mème : ${error.message}`);
            await modalInteraction.reply({
              content: t(lang, 'meme_error'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }
        })
        .catch(error => {
          logger.error(`Erreur modal meme : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande voice-role
  {
    data: new SlashCommandBuilder()
      .setName('voice-role')
      .setDescription(t('fr', 'voice_role_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_desc') })
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription(t('fr', 'voice_role_add_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_add_desc') })
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription(t('fr', 'voice_role_channel_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_channel_desc') })
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildVoice)
          )
          .addRoleOption(option =>
            option
              .setName('role')
              .setDescription(t('fr', 'voice_role_role_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_role_desc') })
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('remove')
          .setDescription(t('fr', 'voice_role_remove_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_remove_desc') })
          .addChannelOption(option =>
            option
              .setName('channel')
              .setDescription(t('fr', 'voice_role_channel_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'voice_role_channel_desc') })
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildVoice)
          )
      )
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageRoles)) return;
      if (!applyCooldown(interaction, 'voice-role', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const subcommand = interaction.options.getSubcommand();
      const channel = interaction.options.getChannel('channel');

      if (subcommand === 'add') {
        const role = interaction.options.getRole('role');
        if (config.forbiddenMentions.roles.includes(role.id)) {
          return interaction.reply({
            content: t(lang, 'voice_role_forbidden_role'),
            flags: InteractionResponseFlags.Ephemeral
          });
        }
        const stmt = interaction.client.db.prepare('INSERT OR REPLACE INTO voiceRoles (channelId, roleId) VALUES (?, ?)');
        stmt.run(channel.id, role.id);
        await interaction.reply({
          content: t(lang, 'voice_role_add_success', { channel: channel.toString(), role: role.toString() }),
          flags: InteractionResponseFlags.Ephemeral
        });
      } else if (subcommand === 'remove') {
        const stmt = interaction.client.db.prepare('DELETE FROM voiceRoles WHERE channelId = ?');
        stmt.run(channel.id);
        await interaction.reply({
          content: t(lang, 'voice_role_remove_success', { channel: channel.toString() }),
          flags: InteractionResponseFlags.Ephemeral
        });
      }
    }
  },
  // Commande quest
  {
    data: new SlashCommandBuilder()
      .setName('quest')
      .setDescription(t('fr', 'quest_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'quest_desc') })
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageGuild)) return;
      if (!applyCooldown(interaction, 'quest', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('questModal')
        .setTitle(t(lang, 'quest_modal_title'));

      const inputs = [
        { id: 'objective', label: t(lang, 'quest_objective_label'), style: TextInputStyle.Paragraph, required: true },
        { id: 'reward', label: t(lang, 'quest_reward_label'), style: TextInputStyle.Short, required: true },
        { id: 'duration', label: t(lang, 'quest_duration_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'questModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const objective = modalInteraction.fields.getTextInputValue('objective');
          const reward = modalInteraction.fields.getTextInputValue('reward');
          const duration = parseInt(modalInteraction.fields.getTextInputValue('duration'));

          if (isNaN(duration) || duration <= 0) {
            return modalInteraction.reply({
              content: t(lang, 'interaction_error') + ': **Durée invalide**',
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const questId = Date.now().toString();
          const channel = interaction.guild.channels.cache.get(config.questChannelId);
          if (!channel) {
            return modalInteraction.reply({
              content: t(lang, 'quest_channel_not_found'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }

          const endTime = Date.now() + duration * 60 * 1000;
          const embed = createEmbed(
            t(lang, 'quest_title'),
            t(lang, 'quest_desc', { objective, reward, minutes: duration, endTime: `<t:${Math.floor(endTime / 1000)}:R>` }),
            '#FFD700'
          );

          const participateButton = new ButtonBuilder()
            .setCustomId(`quest_participate_${questId}`)
            .setLabel(t(lang, 'quest_participate_button', { objective }))
            .setStyle(ButtonStyle.Primary);

          const message = await channel.send({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(participateButton)]
          });

          interaction.client.db.prepare('INSERT INTO quests (questId, messageId, channelId, objective, reward, endTime, progress, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(questId, message.id, channel.id, objective, reward, endTime, 0, 100);

          await modalInteraction.reply({
            content: t(lang, 'quest_success'),
            flags: InteractionResponseFlags.Ephemeral
          });
        })
        .catch(error => {
          logger.error(`Erreur modal quest : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande trivia
  {
    data: new SlashCommandBuilder()
      .setName('trivia')
      .setDescription(t('fr', 'trivia_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'trivia_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'trivia', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const stmt = interaction.client.db.prepare('SELECT * FROM trivia_questions WHERE lang = ?');
      const questions = stmt.all(lang) || [
        {
          question: lang === 'fr' ? "Quelle est la capitale de la France ?" : "What is the capital of France?",
          answers: JSON.stringify(["Paris", "Lyon", "Marseille", "Toulouse"]),
          correct: 0
        },
        {
          question: lang === 'fr' ? "Quel est le plus grand océan ?" : "What is the largest ocean?",
          answers: JSON.stringify(["Atlantique", "Pacifique", "Indien", "Arctique"]),
          correct: 1
        }
      ];

      const question = questions[Math.floor(Math.random() * questions.length)];
      const answers = JSON.parse(question.answers);
      const embed = createEmbed(
        t(lang, 'trivia_title'),
        question.question,
        '#FFD700'
      );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('trivia_answer')
        .setPlaceholder(t(lang, 'trivia_select_placeholder', { question: question.question }))
        .addOptions(answers.map((answer, index) => ({
          label: answer,
          value: index.toString()
        })));

      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu)]
      });

      const filter = i => i.customId === 'trivia_answer' && i.user.id === interaction.user.id;
      const collector = interaction.channel.createMessageComponentCollector({ filter, time: 15000 });

      collector.on('collect', async i => {
        const selected = parseInt(i.values[0]);
        const isCorrect = selected === question.correct;

        const resultEmbed = createEmbed(
          t(lang, 'trivia_title'),
          isCorrect
            ? t(lang, 'trivia_correct', { answer: answers[question.correct] })
            : t(lang, 'trivia_incorrect', { answer: answers[question.correct] }),
          isCorrect ? '#00FF00' : '#FF0000'
        );

        if (isCorrect) {
          const stmt = interaction.client.db.prepare('UPDATE profiles SET points = points + ? WHERE userId = ?');
          stmt.run(10, i.user.id);
        }

        await i.update({ embeds: [resultEmbed], components: [] });
        collector.stop();
      });

      collector.on('end', async () => {
        if (!collector.collected.size) {
          await interaction.editReply({ components: [] });
        }
      });
    }
  },
  // Commande custom-emoji
  {
    data: new SlashCommandBuilder()
      .setName('custom-emoji')
      .setDescription(t('fr', 'custom_emoji_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'custom_emoji_desc') })
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEmojisAndStickers),
    async execute(interaction) {
      if (!checkPermissions(interaction, PermissionsBitField.Flags.ManageEmojisAndStickers)) return;
      if (!applyCooldown(interaction, 'custom-emoji', 30)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const modal = new ModalBuilder()
        .setCustomId('emojiModal')
        .setTitle(t(lang, 'custom_emoji_modal_title'));

      const inputs = [
        { id: 'name', label: t(lang, 'custom_emoji_name_label'), style: TextInputStyle.Short, required: true },
        { id: 'image', label: t(lang, 'custom_emoji_image_label'), style: TextInputStyle.Short, required: true }
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

      const filter = i => i.customId === 'emojiModal' && i.user.id === interaction.user.id;
      interaction.awaitModalSubmit({ filter, time: 300000 })
        .then(async modalInteraction => {
          const name = modalInteraction.fields.getTextInputValue('name').replace(/[^a-zA-Z0-9_]/g, '');
          const imageUrl = modalInteraction.fields.getTextInputValue('image');

          try {
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error('Image invalide');
            const buffer = Buffer.from(await response.arrayBuffer());

            const emoji = await interaction.guild.emojis.create({
              attachment: buffer,
              name
            });

            const embed = createEmbed(
              t(lang, 'custom_emoji_title'),
              t(lang, 'custom_emoji_success', { emoji: emoji.toString() }),
              '#FFD700'
            );

            await modalInteraction.reply({ embeds: [embed] });
          } catch (error) {
            logger.error(`Erreur création emoji : ${error.message}`);
            await modalInteraction.reply({
              content: t(lang, 'custom_emoji_error'),
              flags: InteractionResponseFlags.Ephemeral
            });
          }
        })
        .catch(error => {
          logger.error(`Erreur modal emoji : ${error.message}`);
          modalInteraction.reply({
            content: t(lang, 'interaction_error'),
            flags: InteractionResponseFlags.Ephemeral
          });
        });
    }
  },
  // Commande profile
  {
    data: new SlashCommandBuilder()
      .setName('profile')
      .setDescription(t('fr', 'profile_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'profile_desc') }),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'profile', 10)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const stmt = interaction.client.db.prepare('SELECT bio, games, socials, points, level FROM profiles WHERE userId = ?');
      const profile = stmt.get(interaction.user.id) || {
        bio: 'Aucune bio',
        games: 'Aucun jeu',
        socials: 'Aucun réseau',
        points: 0,
        level: 0
      };

      const embed = createEmbed(
        t(lang, 'profile_title', { username: interaction.user.username }),
        null,
        '#FFD700',
        {
          thumbnail: interaction.user.displayAvatarURL({ dynamic: true }),
          fields: [
            { name: t(lang, 'profile_bio_label'), value: profile.bio || 'Non définie', inline: true },
            { name: t(lang, 'profile_games_label'), value: profile.games || 'Non définis', inline: true },
            { name: t(lang, 'profile_socials_label'), value: profile.socials || 'Non définis', inline: true },
            { name: t(lang, 'profile_points_label'), value: `${profile.points} XP`, inline: true },
            { name: t(lang, 'profile_level_label'), value: `Niveau ${profile.level}`, inline: true }
          ]
        }
      );

      const editButton = new ButtonBuilder()
        .setCustomId('edit-profile')
        .setLabel(t(lang, 'profile_edit_button'))
        .setStyle(ButtonStyle.Primary);

      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(editButton)],
        flags: InteractionResponseFlags.Ephemeral
      });

      const filter = i => i.customId === 'edit-profile' && i.user.id === interaction.user.id;
      const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

      collector.on('collect', async i => {
        const modal = new ModalBuilder()
          .setCustomId('profileModal')
          .setTitle(t(lang, 'profile_edit_modal_title'));

        const inputs = [
          { id: 'bio', label: t(lang, 'profile_bio_label'), style: TextInputStyle.Paragraph, value: profile.bio, required: false },
          { id: 'games', label: t(lang, 'profile_games_label'), style: TextInputStyle.Short, value: profile.games, required: false },
          { id: 'socials', label: t(lang, 'profile_socials_label'), style: TextInputStyle.Short, value: profile.socials, required: false }
        ];

        modal.addComponents(inputs.map(input =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(input.id)
              .setLabel(input.label)
              .setStyle(input.style)
              .setValue(input.value || '')
              .setRequired(input.required)
          )
        ));

        await i.showModal(modal);

        const modalFilter = m => m.customId === 'profileModal' && m.user.id === i.user.id;
        i.awaitModalSubmit({ filter: modalFilter, time: 300000 })
          .then(async modalInteraction => {
            const newBio = modalInteraction.fields.getTextInputValue('bio') || 'Aucune bio';
            const newGames = modalInteraction.fields.getTextInputValue('games') || 'Aucun jeu';
            const newSocials = modalInteraction.fields.getTextInputValue('socials') || 'Aucun réseau';

            const stmt = interaction.client.db.prepare('INSERT OR REPLACE INTO profiles (userId, bio, games, socials, points, level) VALUES (?, ?, ?, ?, ?, ?)');
            stmt.run(interaction.user.id, newBio, newGames, newSocials, profile.points, profile.level);

            const updatedEmbed = createEmbed(
              t(lang, 'profile_title', { username: interaction.user.username }),
              t(lang, 'profile_updated'),
              '#FFD700',
              {
                thumbnail: interaction.user.displayAvatarURL({ dynamic: true }),
                fields: [
                  { name: t(lang, 'profile_bio_label'), value: newBio, inline: true },
                  { name: t(lang, 'profile_games_label'), value: newGames, inline: true },
                  { name: t(lang, 'profile_socials_label'), value: newSocials, inline: true },
                  { name: t(lang, 'profile_points_label'), value: `${profile.points} XP`, inline: true },
                  { name: t(lang, 'profile_level_label'), value: `Niveau ${profile.level}`, inline: true }
                ]
              }
            );

            await modalInteraction.reply({ embeds: [updatedEmbed], flags: InteractionResponseFlags.Ephemeral });
          })
          .catch(error => {
            logger.error(`Erreur modal profile : ${error.message}`);
            modalInteraction.reply({
              content: t(lang, 'interaction_error'),
              flags: InteractionResponseFlags.Ephemeral
            });
          });
      });

      collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
      });
    }
  },
  // Commande rep
  {
    data: new SlashCommandBuilder()
      .setName('rep')
      .setDescription(t('fr', 'rep_desc'))
      .setDescriptionLocalizations({ 'en-US': t('en-US', 'rep_desc') })
      .addSubcommand(subcommand =>
        subcommand
          .setName('give')
          .setDescription(t('fr', 'rep_give_desc'))
          .setDescriptionLocalizations({ 'en-US': t('en-US', 'rep_give_desc') })
          .addUserOption(option =>
            option
              .setName('utilisateur')
              .setDescription(t('fr', 'rep_user_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'rep_user_desc') })
              .setRequired(true)
          )
          .addIntegerOption(option =>
            option
              .setName('points')
              .setDescription(t('fr', 'rep_points_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'rep_points_desc') })
              .setRequired(true)
              .addChoices(
                { name: '+1', value: 1 },
                { name: '-1', value: -1 }
              )
          )
          .addStringOption(option =>
            option
              .setName('raison')
              .setDescription(t('fr', 'rep_reason_desc'))
              .setDescriptionLocalizations({ 'en-US': t('en-US', 'rep_reason_desc') })
              .setRequired(true)
          )
      ),
    async execute(interaction) {
      if (!applyCooldown(interaction, 'rep', 60)) return;

      const lang = interaction.locale.startsWith('fr') ? 'fr' : 'en-US';
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'give') {
        const targetUser = interaction.options.getUser('utilisateur');
        const points = interaction.options.getInteger('points');
        const reason = interaction.options.getString('raison');

        if (targetUser.id === interaction.user.id) {
          return interaction.reply({
            content: t(lang, 'rep_self_error', { user: targetUser.tag }),
            flags: InteractionResponseFlags.Ephemeral
          });
        }

        // Query and update SQLite database for reputation
        const stmt = interaction.client.db.prepare('SELECT points, lastGiven FROM reputation WHERE userId = ? AND giverId = ?');
        const rep = stmt.get(targetUser.id, interaction.user.id) || { points: 0, lastGiven: '' };
        const today = new Date().toISOString().split('T')[0];

        if (rep.lastGiven === today && Math.abs(rep.points) >= 5) {
          return interaction.reply({
            content: t(lang, 'rep_limit'),
            flags: InteractionResponseFlags.Ephemeral
          });
        }

        const newPoints = rep.points + points;
        const updateStmt = interaction.client.db.prepare('INSERT OR REPLACE INTO reputation (userId, giverId, points, lastGiven) VALUES (?, ?, ?, ?)');
        updateStmt.run(targetUser.id, interaction.user.id, newPoints, today);

        const embed = createEmbed(
          t(lang, 'rep_success', { user: targetUser.tag }),
          t(lang, 'rep_desc_success', { points: newPoints, reason }),
          points > 0 ? '#00FF00' : '#FF0000'
        );

        await interaction.reply({ embeds: [embed] });

        const logChannel = interaction.guild.channels.cache.get(config.logChannelId);
        if (logChannel) {
          const logEmbed = createEmbed(
            t(lang, 'log_rep_title'),
            t(lang, 'log_rep_desc', {
              user: targetUser.tag,
              giver: interaction.user.tag,
              points,
              reason
            }),
            points > 0 ? '#00FF00' : '#FF0000'
          );
          await logChannel.send({ embeds: [logEmbed] });
        }
      }
    }
  }
];

// Exporter les commandes
module.exports = commands;