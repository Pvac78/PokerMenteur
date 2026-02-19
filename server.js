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
const VAL_MAP = {'7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    return deck.sort(() => Math.random() - 0.5);
}

function checkBid(allCards, combo, targetValue, targetValue2) {
    const counts = {};
    const suitVals = {'♠':[], '♣':[], '♥':[], '♦':[]};

    allCards.forEach(c => {
        let valStr = c.slice(0, -1);
        let suit = c.slice(-1);
        let v = VAL_MAP[valStr];
        counts[v] = (counts[v] || 0) + 1;
        suitVals[suit].push(v);
    });

    const tV1 = VAL_MAP[targetValue];
    const tV2 = targetValue2 ? VAL_MAP[targetValue2] : null;

    switch(combo) {
        case "Carte Haute": return counts[tV1] >= 1;
        case "Paire": return counts[tV1] >= 2;
        case "Double Paire": 
            if (!tV2) return false;
            return (counts[tV1] >= 2 && counts[tV2] >= 2);
        case "Brelan": return counts[tV1] >= 3;
        case "Full": 
            if (!tV2) return false;
            return (counts[tV1] >= 3 && counts[tV2] >= 2);
        case "Carré": return counts[tV1] >= 4;
        case "Quinte":
            for(let i=0; i<5; i++) if(!counts[tV1 - i]) return false;
            return true;
        case "Quinte Flush":
            for (let s in suitVals) {
                let hasAll = true;
                for(let i=0; i<5; i++) if(!suitVals[s].includes(tV1 - i)) hasAll = false;
                if (hasAll) return true;
            }
            return false;
        default: return false;
    }
}

function startNewRound(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    let activePlayers = room.players.filter(p => !p.isOut);
    if (activePlayers.length <= 1) {
        io.to(roomName).emit('gameOver', { winner: activePlayers[0] ? activePlayers[0].name : 'Inconnu' });
        return;
    }

    room.deck = createDeck();
    room.currentBid = null;
    room.bidHistory = []; // Reset de l'historique !

    activePlayers.forEach(p => {
        p.cards = [];
        let cardsToDeal = 1 + p.penalties; 
        for(let i=0; i<cardsToDeal; i++) {
            if(room.deck.length > 0) p.cards.push(room.deck.pop());
        }
        io.to(p.id).emit('yourCards', p.cards);
    });

    if (room.players[room.turnIndex].isOut) {
        room.turnIndex = room.players.findIndex(p => !p.isOut);
    }

    io.to(roomName).emit('roundStarted');
    io.to(roomName).emit('updateGameState', { 
        currentBid: null, 
        bidHistory: room.bidHistory,
        nextPlayer: room.players[room.turnIndex].name 
    });
    io.to(roomName).emit('updatePlayers', { players: room.players, hostId: room.hostId });
}

io.on('connection', (socket) => {
    socket.emit('updateRooms', Object.keys(rooms));

    socket.on('createRoom', (roomName) => {
        if (!rooms[roomName]) {
            // Le créateur est désigné comme l'Hôte (hostId)
            rooms[roomName] = { hostId: socket.id, players: [], gameStarted: false, turnIndex: 0, bidHistory: [] };
            io.emit('updateRooms', Object.keys(rooms));
        }
    });

    socket.on('joinRoom', ({ roomName, playerName }) => {
        let room = rooms[roomName];
        if (room && !room.gameStarted) {
            socket.join(roomName);
            // Sécurité : si la salle est vide mais existe, le premier devient l'hôte
            if (room.players.length === 0) room.hostId = socket.id;
            
            room.players.push({ id: socket.id, name: playerName, cards: [], penalties: 0, isOut: false });
            io.to(roomName).emit('updatePlayers', { players: room.players, hostId: room.hostId });
        }
    });

    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        // Seul l'hôte peut lancer, et il faut 2 joueurs min
        if (room && room.hostId === socket.id && room.players.length >= 2) {
            room.gameStarted = true;
            room.turnIndex = 0;
            io.to(roomName).emit('gameStarted');
            startNewRound(roomName);
        }
    });

    socket.on('placeBid', ({ roomName, bid }) => {
        const room = rooms[roomName];
        if (room) {
            if (room.currentBid) {
                const oldIdx = HAND_HIERARCHY.indexOf(room.currentBid.combo);
                const newIdx = HAND_HIERARCHY.indexOf(bid.combo);
                if (newIdx < oldIdx) return; 
                if (newIdx === oldIdx) {
                    const newV1 = VAL_MAP[bid.value];
                    const oldV1 = VAL_MAP[room.currentBid.value];
                    if (newV1 < oldV1) return;
                    if (newV1 === oldV1 && bid.value2 && room.currentBid.value2) {
                        const newV2 = VAL_MAP[bid.value2];
                        const oldV2 = VAL_MAP[room.currentBid.value2];
                        if (newV2 <= oldV2) return; 
                    } else if (newV1 === oldV1) return;
                }
            }
            
            room.currentBid = bid;
            room.currentBid.playerId = socket.id;
            room.bidHistory.push(room.currentBid);

            do {
                room.turnIndex = (room.turnIndex + 1) % room.players.length;
            } while (room.players[room.turnIndex].isOut);

            io.to(roomName).emit('updateGameState', { 
                currentBid: room.currentBid, 
                bidHistory: room.bidHistory,
                nextPlayer: room.players[room.turnIndex].name 
            });
        }
    });

    socket.on('callLiar', (roomName) => {
        const room = rooms[roomName];
        if (!room || !room.currentBid) return;

        let allCards = [];
        room.players.filter(p => !p.isOut).forEach(p => allCards = allCards.concat(p.cards));

        const isBidTrue = checkBid(allCards, room.currentBid.combo, room.currentBid.value, room.currentBid.value2);

        let loserId = isBidTrue ? room.players[room.turnIndex].id : room.currentBid.playerId;
        let loser = room.players.find(p => p.id === loserId);

        loser.penalties += 1;
        let eliminated = false;
        if (loser.penalties >= 5) {
            loser.isOut = true;
            eliminated = true;
        }

        io.to(roomName).emit('revealAll', { 
            cards: allCards, 
            bidder: room.currentBid.playerName, 
            caller: room.players[room.turnIndex].name,
            loserName: loser.name,
            isBidTrue: isBidTrue,
            eliminated: eliminated
        });
        
        room.turnIndex = room.players.findIndex(p => p.id === loserId);

        setTimeout(() => {
            startNewRound(roomName);
        }, 8000);
    });

    socket.on('disconnect', () => {
        for (const roomName in rooms) {
            const room = rooms[roomName];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    delete rooms[roomName];
                } else {
                    // Si l'hôte part, on donne le rôle au suivant
                    if (socket.id === room.hostId) room.hostId = room.players[0].id;
                    io.to(roomName).emit('updatePlayers', { players: room.players, hostId: room.hostId });
                }
                io.emit('updateRooms', Object.keys(rooms));
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));