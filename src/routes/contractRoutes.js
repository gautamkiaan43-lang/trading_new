const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');

// Get all available contracts
router.get('/all', contractController.getAllContracts);

// Get selected/active contracts
router.get('/selected', contractController.getSelectedContracts);

// Save selected contracts
router.post('/save-selection', contractController.saveContractSelection);

// Get contracts by search
router.get('/search', contractController.searchContracts);

module.exports = router;
