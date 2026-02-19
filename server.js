const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; 

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push(v + s);
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.emit('updateRooms', Object.keys(rooms));

    socket.on('createRoom', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = { 
                players: [], 
                gameStarted: false, 
                deck: [],
                currentBid: null,
                turnIndex: 0 
            };
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
            
            room.players.forEach(player => {
                player.cards = [room.deck.pop()]; 
                io.to(player.id).emit('yourCards', player.cards);
            });

            io.to(roomName).emit('gameStarted');
            // On annonce le premier joueur
            io.to(roomName).emit('updateGameState', {
                currentBid: null,
                nextPlayer: room.players[0].name
            });
        }
    });

    socket.on('placeBid', ({ roomName, bid }) => {
        const room = rooms[roomName];
        if (room) {
            room.currentBid = bid;
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            
            io.to(roomName).emit('updateGameState', {
                currentBid: room.currentBid,
                nextPlayer: room.players[room.turnIndex].name
            });
        }
    });

    socket.on('disconnect', () => {
        for (const roomName in rooms) {
            const room = rooms[roomName];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) delete rooms[roomName];
                else io.to(roomName).emit('updatePlayers', room.players);
                io.emit('updateRooms', Object.keys(rooms));
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur sur le port ${PORT}`);
});