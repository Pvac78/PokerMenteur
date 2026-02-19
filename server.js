const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; 

const HAND_HIERARCHY = ["Carte Haute", "Paire", "Double Paire", "Brelan", "Quinte", "Full", "Carré", "Quinte Flush"];

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.emit('updateRooms', Object.keys(rooms));

    socket.on('createRoom', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = { players: [], gameStarted: false, deck: [], currentBid: null, turnIndex: 0 };
            io.emit('updateRooms', Object.keys(rooms));
        }
    });

    socket.on('joinRoom', ({ roomName, playerName }) => {
        if (rooms[roomName] && !rooms[roomName].gameStarted) {
            socket.join(roomName);
            rooms[roomName].players.push({ id: socket.id, name: playerName, cards: [] });
            io.to(roomName).emit('updatePlayers', rooms[roomName].players);
        }
    });

    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            room.deck = createDeck();
            room.turnIndex = 0;
            room.currentBid = null;
            room.players.forEach(p => { p.cards = [room.deck.pop()]; io.to(p.id).emit('yourCards', p.cards); });
            io.to(roomName).emit('gameStarted');
            io.to(roomName).emit('updateGameState', { currentBid: null, nextPlayer: room.players[0].name });
        }
    });

    socket.on('placeBid', ({ roomName, bid }) => {
        const room = rooms[roomName];
        if (room) {
            // Vérification surenchère
            if (room.currentBid) {
                const oldIdx = HAND_HIERARCHY.indexOf(room.currentBid.combo);
                const newIdx = HAND_HIERARCHY.indexOf(bid.combo);
                if (newIdx < oldIdx) return; // Refusé si plus faible
                if (newIdx === oldIdx && bid.value <= room.currentBid.value) return; // Refusé si même combo mais valeur plus faible
            }
            
            room.currentBid = bid;
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            io.to(roomName).emit('updateGameState', { currentBid: room.currentBid, nextPlayer: room.players[room.turnIndex].name });
        }
    });

    socket.on('callLiar', (roomName) => {
        const room = rooms[roomName];
        if (!room || !room.currentBid) return;

        // Récupérer toutes les cartes sur la table
        let allCards = [];
        room.players.forEach(p => allCards = allCards.concat(p.cards));

        io.to(roomName).emit('revealAll', { cards: allCards, bidder: room.currentBid.playerName, caller: room.players[room.turnIndex].name });
        
        // Reset pour la manche suivante après 5 secondes
        setTimeout(() => {
            room.gameStarted = false;
            io.to(roomName).emit('resetGame');
        }, 8000);
    });

    socket.on('disconnect', () => { /* ... idem précédent ... */ });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));