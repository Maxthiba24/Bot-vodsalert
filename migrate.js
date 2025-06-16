const sqlite3 = require('better-sqlite3');
const winston = require('winston');
const triviaQuestions = require('./triviaQuestions.js');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'migration.log' })
  ]
});

const db = sqlite3('./bot.db', { verbose: logger.info.bind(logger) });

function migrateDatabase() {
  try {
    // Créer la table trivia_questions si elle n'existe pas
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trivia_questions'").get();
    if (!tableExists) {
      db.exec(`
        CREATE TABLE trivia_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT,
          options TEXT,
          answer INTEGER
        )
      `);
      logger.info('Table trivia_questions créée.');
    }

    // Vérifier si la table est vide et insérer les questions depuis triviaQuestions.js
    const triviaCount = db.prepare('SELECT COUNT(*) as count FROM trivia_questions').get().count;
    if (triviaCount === 0) {
      const stmt = db.prepare('INSERT INTO trivia_questions (question, options, answer) VALUES (?, ?, ?)');
      triviaQuestions.forEach(q => stmt.run(q.question, JSON.stringify(q.options), q.answer));
      logger.info('Questions trivia insérées depuis triviaQuestions.js.');
    }

    // Ajouter d'autres migrations ici si nécessaire
    logger.info('Migration terminée avec succès.');
  } catch (error) {
    logger.error(`Erreur lors de la migration : ${error.message}`);
  } finally {
    db.close();
  }
}

migrateDatabase();