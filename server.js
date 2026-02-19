const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const deck = [];
    const suits = ['♠️', '♥️', '♣️', '♦️'];
    for (let v = 7; v <= 14; v++) suits.forEach(s => deck.push({ v, s }));
    deck.sort(() => Math.random() - 0.5);

    room.players.forEach(p => {
        if (!p.isOut) {
            p.cards = [];
            // Distribution : 1 carte de base + 1 par pénalité
            const cardsToDeal = 1 + p.penalties;
            for (let i = 0; i < cardsToDeal; i++) {
                if (deck.length > 0) p.cards.push(deck.pop());
            }
            io.to(p.id).emit('yourCards', p.cards);
        }
    });
    
    room.lastBid = null;
    // On commence par le premier joueur non éliminé
    room.currentTurn = room.players.findIndex(p => !p.isOut);
    
    io.to(roomId).emit('roundStarted', { 
        turnId: room.players[room.currentTurn].id,
        playersInfo: room.players.map(p => ({ 
            name: p.name, 
            id: p.id, 
            cardCount: p.cards.length, 
            penalties: p.penalties,
            isOut: p.isOut
        }))
    });
}

io.on('connection', (socket) => {
    socket.emit('listRooms', Object.values(rooms));

    socket.on('createRoom', (data) => {
        const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
        rooms[roomId] = {
            id: roomId,
            name: data.tableName,
            players: [],
            gameStarted: false,
            lastBid: null,
            currentTurn: 0
        };
        socket.emit('roomCreated', roomId);
        io.emit('listRooms', Object.values(rooms));
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < 6) {
            socket.join(data.roomId);
            if (!room.players.find(p => p.id === socket.id)) {
                room.players.push({ id: socket.id, name: data.playerName, cards: [], penalties: 0, isOut: false });
            }
            io.to(data.roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            startNewRound(roomId);
        }
    });

    socket.on('makeBid', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        room.lastBid = { ...data.bid, playerIdx: room.currentTurn };
        
        do {
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
        } while (room.players[room.currentTurn].isOut);

        io.to(data.roomId).emit('bidUpdate', {
            bid: data.bid,
            nextTurn: room.players[room.currentTurn].id,
            playerName: room.players[room.lastBid.playerIdx].name
        });
    });

    socket.on('callLiar', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.lastBid) return;

        const allCards = room.players.flatMap(p => p.cards);
        const count = allCards.filter(c => c.v === room.lastBid.v).length;
        const success = count >= room.lastBid.count;
        
        // Si l'annonce était vraie, celui qui a dit "Menteur" perd. Sinon, le parieur perd.
        const loserIdx = success ? room.currentTurn : room.lastBid.playerIdx;
        
        room.players[loserIdx].penalties++;
        if (room.players[loserIdx].penalties >= 6) room.players[loserIdx].isOut = true;

        io.to(roomId).emit('liarResult', {
            liarFound: !success,
            loserName: room.players[loserIdx].name,
            totalCards: count,
            bidValue: room.lastBid.v,
            bidCount: room.lastBid.count
        });

        setTimeout(() => {
            const winners = room.players.filter(p => !p.isOut);
            if (winners.length <= 1) {
                io.to(roomId).emit('gameOver', { winner: winners[0].name });
                delete rooms[roomId];
            } else {
                startNewRound(roomId);
            }
        }, 5000);
    });
});

// Remplace 3000 par 3001
server.listen(3001, () => console.log('🚀 Serveur Gemini : http://localhost:3001'));