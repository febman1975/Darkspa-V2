const mongoose = require('mongoose');

async function connectDatabase(mongoUri) {
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  });
}

module.exports = {
  connectDatabase
};
