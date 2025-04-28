require('dotenv').config(); // Добавь в самом начале файла
const express = require('express');
const { Server } = require("socket.io");
const { v4: uuidV4 } = require('uuid');
const http = require('http');
const mongoose = require('mongoose');
const port = process.env.PORT || 8080;
const User = require('./models/User.js')
const bcrypt = require('bcryptjs');
const cors = require('cors');
const cookieParser = require('cookie-parser')

const app = express(); // initialize express

const server = http.createServer(app);

app.use(express.json());
// set port to value received from environment variable or 8080 if null

app.use(cors({
  origin: 'http://localhost:3000', // Разрешаем доступ только с localhost:3000
  methods: ['GET', 'POST'], // Разрешаем только эти методы
  allowedHeaders: ['Content-Type'] // Разрешаем только эти заголовки
}));

// upgrade http server to websocket server
const io = new Server(server, {
  cors: '*', // allow connection from any origin
});

const rooms = new Map();

function removeDuplicatesByRoomId(arr) {
  return arr.filter(
    (item, index, self) =>
      index === self.findIndex((obj) => obj.roomId === item.roomId) 
  );
}
let TVRooms = [];
let TVRoom = null;

// io.connection
io.on('connection', (socket) => {
  console.log(socket.id, 'connected');
  socket.on('freeRoom', (callback) => {
    let freeRooms = [];
    for (let [key, value] of rooms) {
      if (value.players.length < 2) {
        const opponentOrientation = value.players[0].orientation == "white" ? "black" : "white"
        freeRooms.push({roomId:key,opponentOrientation,timeControl:value.timeControl.white})
      }
    }
    callback(removeDuplicatesByRoomId(freeRooms))
  });

  // socket.on('username')
  // socket.on('username', (username) => {
  //   console.log("username:",username);  
  //   socket.data.username = username;
  // });

  // createRoom
  socket.on('createRoom', async (data,callback) => { // callback here refers to the callback function from the client passed as data
    const orientation = Math.random() < 0.5 ? 'white' : 'black';
    const roomId = uuidV4(); // <- 1 create a new uuid
    await socket.join(roomId); // <- 2 make creating user join the room
   
    // set roomId as a key and roomData including players as value in the map
    rooms.set(roomId, { // <- 3
      roomId,
      players: [{ id: socket.id, username: socket.data?.username, orientation}],
      moves:[],
      intervals:[],
      timeControl:{
        white: {time:data.time, addTime:data.addTime},
        black: {time:data.time, addTime:data.addTime}
      }
    });

    // returns Map(1){'2b5b51a9-707b-42d6-9da8-dc19f863c0d0' => [{id: 'socketid', username: 'username1'}]}
    callback(roomId,orientation)

    const opponentOrientation = orientation == "white" ? "black" : "white"
    let freeRooms = [];
    for (let [key, value] of rooms) {
      if (value.players.length < 2) {
        const opponentOrientation = value.players[0].orientation == "white" ? "black" : "white"
        freeRooms.push({roomId:key,opponentOrientation,timeControl:value.timeControl.white})
      }
    }
    io.emit('newRoom', removeDuplicatesByRoomId([...freeRooms,{roomId,opponentOrientation,timeControl:{time:data.time, addTime:data.addTime}}]))// <- 4 respond with roomId to client by calling the callback function from the client
  });

	socket.on('joinRoom', async (args, callback) => {
    // check if room exists and has a player waiting
    let freeRooms = [];
    for (let [key, value] of rooms) {
      if (value.players.length < 2) {
        const opponentOrientation = value.players[0].orientation == "white" ? "black" : "white"
        freeRooms.push({roomId:key,opponentOrientation,timeControl:value.timeControl.white})
      }
    }
    io.emit('newRoom', removeDuplicatesByRoomId(freeRooms.filter((e)=>e.roomId != args.roomId)))

    const room = rooms.get(args.roomId);
    let error, message;

    if (!room) { // if room does not exist
      error = true;
      message = 'room does not exist';
    } else if (room.players.length <= 0) { // if room is empty set appropriate message
      error = true;
      message = 'room is empty';

    } else if (room.players.length >= 2) { // if room is full
      error = true;
      message = 'room is full'; // set message to 'room is full'
    }

    if (error) {
      // if there's an error, check if the client passed a callback,
      // call the callback (if it exists) with an error object and exit or 
      // just exit if the callback is not given

      if (callback) { // if user passed a callback, call it with an error payload
        callback({
          error,
          message
        });
      }

      return; // exit
    }

    await socket.join(args.roomId); // make the joining client join the room

    // add the joining user's data to the list of players in the room
    const roomUpdate = {
      ...room,
      players: [
        ...room.players,
        { id: socket.id, username: socket.data?.username, orientation:args.orientation },
      ],
      moves:[],
      intervals:[],
    };
    // console.log(roomUpdate)

    rooms.set(args.roomId, roomUpdate);
    console.log(rooms)
    callback(roomUpdate); // respond to the client with the room details.

    // emit an 'opponentJoined' event to the room to tell the other player that an opponent has joined
    socket.to(args.roomId).emit('opponentJoined', roomUpdate);

    
    if (!TVRoom) {
      io.emit('TVGame', {...roomUpdate, intervals: undefined});
      TVRoom = roomUpdate;
    }
  });

  socket.emit('TVGame', TVRoom && {...TVRoom, intervals: undefined});

  let intervalId = '';
  socket.on('move', (data) => {
    const room = rooms.get(data.room);
    room.moves.push(data.move);

    if(room.moves[1]){
      let side = room.moves[room.moves.length-1].color === 'b' ? 'white' : 'black';
      if(room.moves[2] && room.moves[room.moves.length-1].color === 'w'){
        room.timeControl.white.time += room.timeControl.white.addTime;
        socket.emit("timer", room.timeControl.white.time, 'white');
        socket.to(data.room).emit("timer", room.timeControl.white.time, 'white');

        //TV
        if(TVRoom?.roomId == data.room){
          TVRoom = room;
          io.emit('TVGame', {...TVRoom, intervals: undefined});
        }
      }else if(room.moves[2] && room.moves[room.moves.length-1].color === 'b'){
        room.timeControl.black.time += room.timeControl.black.addTime;
        socket.emit("timer", room.timeControl.black.time, 'black');
        socket.to(data.room).emit("timer", room.timeControl.black.time, 'black');

        //TV
        if(TVRoom?.roomId == data.room){
          TVRoom = room;
          io.emit('TVGame', {...TVRoom, intervals: undefined});
        }
      }
      
      room.intervals.forEach((id) => clearInterval(id));

      intervalId = setInterval(() => {
        if (room.moves[room.moves.length - 1].color === 'b') {
          room.timeControl.white.time -= 1000;
          socket.emit("timer", room.timeControl.white.time, side);
          socket.to(data.room).emit("timer", room.timeControl.white.time, side);

          //TV
          if(TVRoom?.roomId == data.room){
            TVRoom = room;
            io.emit('TVGame', {...TVRoom, intervals: undefined});
          }
        } else {
          room.timeControl.black.time -= 1000;
          socket.emit("timer", room.timeControl.black.time, side);
          socket.to(data.room).emit("timer", room.timeControl.black.time, side);

          //TV
          if(TVRoom?.roomId == data.room){
            TVRoom = room;
            io.emit('TVGame', {...TVRoom, intervals: undefined});
          }
        }
      },1000);
    }
    console.log(room.timeControl.white.time)
    // emit to all sockets in the room except the emitting socket
    room.intervals.push(intervalId)
    socket.to(data.room).emit('move', data.move);
    if(TVRoom?.roomId == data.room){
      TVRoom = room;
      io.emit('TVGame', {...TVRoom, intervals: undefined});
    }

    rooms.set(data.room, room);
  });

  socket.on("closeRoom", async (data) => {
    socket.to(data.roomId).emit("closeRoom", data); // <- 1 inform others in the room that the room is closing

    const clientSockets = await io.in(data.roomId).fetchSockets(); // <- 2 get all sockets in a room

    // loop over each socket client
    clientSockets.forEach((s) => {
      s.leave(data.roomId); // <- 3 and make them leave the room on socket.io
    });

    rooms.delete(data.roomId); // <- 4 delete room from rooms map
  });

  socket.on('gameover', (data) => {
    const room = rooms.get(data.roomId);
    room.intervals.forEach((id) => clearInterval(id));
    if(data.reason && data.winner){
      const roomUpdate = {
        ...room,
        endGameStatus: {reason: data.reason, winner: data.winner}
      };
      console.log(roomUpdate.endGameStatus)
      rooms.set(data.roomId, roomUpdate);
    }
    if(TVRoom?.roomId == data.roomId){
      // rooms.delete(data.roomId);

      io.emit('TVGame', TVRoom, data.winner);

      setTimeout(() => {
        TVRoom = null;
        io.emit('TVGame', TVRoom);
      }, 3000);
    }
  })

  socket.on("disconnect", () => {
    const gameRooms = Array.from(rooms.values()); // <- 1

    gameRooms.forEach((room) => { // <- 2
      const userInRoom = room.players.find((player) => player.id === socket.id); // <- 3

      if (userInRoom) {
        room.intervals.forEach((id) => clearInterval(id));
        rooms.delete(room.roomId);
        if (room.players.length < 2) {

          let freeRooms = [];
          for (let [key, value] of rooms) {
            if (value.players.length < 2) {
              const opponentOrientation = value.players[0].orientation == "white" ? "black" : "white"
              freeRooms.push({roomId:key,opponentOrientation,timeControl:value.timeControl.white})
            }
          }
          io.emit('newRoom', removeDuplicatesByRoomId(freeRooms.filter((e) => e.roomId != room.roomId)))

          
          // if there's only 1 player in the room, close it and exit.
          return;
        }

        if(!room.endGameStatus){
          let winner = userInRoom.orientation == "white" ? "black" : "white"
          if(TVRoom?.roomId == room.roomId){
            io.emit('TVGame', TVRoom, winner, 'disconnected');

            setTimeout(() => {
              TVRoom = null;
              io.emit('TVGame', TVRoom);
            }, 3000);
          }
          const roomUpdate = {
            ...room,
            endGameStatus: {reason:"disconnected", winner: winner}
          };
          console.log(roomUpdate)
          socket.to(room.roomId).emit("playerDisconnected", userInRoom); // <- 4
        }
      }
    });
  });

});


app.post('/sign-up', async (req, res) => {
  try {
    const username = req.body.username;
    const password = req.body.password;
    const existingUser = await User.findOne({username});
    if (existingUser) {
      return res.status(400).json('Пользователь с таким именем уже существует');
    }
    if (username.length > 20) {
      return res.status(400).json('Имя не должно превышать 20 символов');
    }
    if (username.length < 3) {
      return res.status(400).json('Имя должно превышать 2 символа');
    }
    if (password.length < 6) {
      return res.status(400).json('Пароль должен превышать 5 символов');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username: username,
      password: hashedPassword,
    });

    await newUser.save();

    res.status(201).json('Пользователь успешно зарегистрирован');

  } catch (error) {
    console.error(error);
    res.status(500).json('Ошибка сервера')
  }
});

app.post('/sign-in', async (req, res) => {
  try {
    const username = req.body.username;
    const password = req.body.password;

    const existingUser = await User.findOne({username});
    if (!existingUser) {
      return res.status(400).json('Пользователя с таким именем не существует');
    }

    const checkPassword = await bcrypt.compare(password, existingUser.password)

    if(!checkPassword){
      return res.status(400).json('Не верный пароль');
    }

    res.status(201).json('Вы успешно авторизовались');

  } catch (error) {
    console.error(error);
    res.status(500).json('Ошибка сервера')
  }
});


async function start () {
  try {
      await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/backup_db");
      server.listen(port, () => console.log(`listening on *:${port}`))
  }catch (e) {
      console.log('sth wrong',e.message)
      process.exit(1)
  }
}

start()
































































// const express = require('express');
// const { Server } = require("socket.io");
// const { v4: uuidV4 } = require('uuid');
// const http = require('http');
// const mongoose = require('mongoose');
// const config = require('config');
// const User = require('./models/User.js')
// const bcrypt = require('bcryptjs');
// const cors = require('cors');
// const cookieParser = require('cookie-parser')

// const app = express(); // initialize express

// const server = http.createServer(app);

// app.use(express.json());
// // set port to value received from environment variable or 8080 if null
// const port = process.env.PORT || 8080

// app.use(cors({
//   origin: 'http://localhost:3000', // Разрешаем доступ только с localhost:3000
//   methods: ['GET', 'POST'], // Разрешаем только эти методы
//   allowedHeaders: ['Content-Type'] // Разрешаем только эти заголовки
// }));

// // upgrade http server to websocket server
// const io = new Server(server, {
//   cors: '*', // allow connection from any origin
// });

// const rooms = new Map();

// function mapToObject(map) {
//   const obj = {};
//   map.forEach((value, key) => {
//     obj[key] = value;
//   });
//   return obj;
// }

// // io.connection
// io.on('connection', (socket) => {
//   console.log(socket.id, 'connected');

//   // socket.on('username')
//   // socket.on('username', (username) => {
//   //   console.log("username:",username);  
//   //   socket.data.username = username;
//   // });

//   // createRoom
//   socket.on('createRoom', async (callback) => { // callback here refers to the callback function from the client passed as data
//     const roomId = uuidV4(); // <- 1 create a new uuid
//     await socket.join(roomId); // <- 2 make creating user join the room
   
//     // set roomId as a key and roomData including players as value in the map
//     rooms.set(roomId, { // <- 3
//       roomId,
//       players: [{ id: socket.id, username: socket.data?.username }]
//     });

//     // returns Map(1){'2b5b51a9-707b-42d6-9da8-dc19f863c0d0' => [{id: 'socketid', username: 'username1'}]}
//     callback(roomId)
//     let newobj = mapToObject(rooms)
//     io.emit('number', {newobj,roomId}); // <- 4 respond with roomId to client by calling the callback function from the client
//   });

// 	socket.on('joinRoom', async (args, callback) => {
//     // check if room exists and has a player waiting
//     // const room = rooms.get(args.roomId);
//     const room = new Map(Object.entries(args.room)).get(args.roomId);
//     let error, message;

//     if (!room) { // if room does not exist
//       error = true;
//       message = 'room does not exist';
//     } else if (room.players.length <= 0) { // if room is empty set appropriate message
//       error = true;
//       message = 'room is empty';
//     } else if (room.players.length >= 2) { // if room is full
//       error = true;
//       message = 'room is full'; // set message to 'room is full'
//     }

//     if (error) {
//       // if there's an error, check if the client passed a callback,
//       // call the callback (if it exists) with an error object and exit or 
//       // just exit if the callback is not given

//       if (callback) { // if user passed a callback, call it with an error payload
//         callback({
//           error,
//           message
//         });
//       }

//       return; // exit
//     }

//     await socket.join(args.roomId); // make the joining client join the room

//     // add the joining user's data to the list of players in the room
//     const roomUpdate = {
//       ...room,
//       players: [
//         ...room.players,
//         { id: socket.id, username: socket.data?.username },
//       ],
//     };
//     // console.log(roomUpdate)

//     rooms.set(args.roomId, roomUpdate);
//     console.log(rooms,roomUpdate)
//     callback(roomUpdate); // respond to the client with the room details.

//     // emit an 'opponentJoined' event to the room to tell the other player that an opponent has joined
//     io.to(args.roomId).emit('opponentJoined', roomUpdate);
//   });

//   console.log(rooms)
//   socket.on('move', (data) => {
//     // emit to all sockets in the room except the emitting socket.
//     socket.to(data.room).emit('move', data.move);
//   });

//   socket.on("disconnect", () => {
//     const gameRooms = Array.from(rooms.values()); // <- 1

//     gameRooms.forEach((room) => { // <- 2
//       const userInRoom = room.players.find((player) => player.id === socket.id); // <- 3

//       if (userInRoom) {
//         if (room.players.length < 2) {
//           // if there's only 1 player in the room, close it and exit.
//           rooms.delete(room.roomId);
//           return;
//         }

//         socket.to(room.roomId).emit("playerDisconnected", userInRoom); // <- 4
//       }
//     });
//   });

//   socket.on("closeRoom", async (data) => {
//     socket.to(data.roomId).emit("closeRoom", data); // <- 1 inform others in the room that the room is closing

//     const clientSockets = await io.in(data.roomId).fetchSockets(); // <- 2 get all sockets in a room

//     // loop over each socket client
//     clientSockets.forEach((s) => {
//       s.leave(data.roomId); // <- 3 and make them leave the room on socket.io
//     });

//     rooms.delete(data.roomId); // <- 4 delete room from rooms map
//   });
// });


// app.post('/sign-up', async (req, res) => {
//   try {
//     const username = req.body.username;
//     const password = req.body.password;
//     const existingUser = await User.findOne({username});
//     if (existingUser) {
//       return res.status(400).json('Пользователь с таким именем уже существует');
//     }
//     if (username.length > 20) {
//       return res.status(400).json('Имя не должно превышать 20 символов');
//     }
//     if (username.length < 3) {
//       return res.status(400).json('Имя должно превышать 2 символа');
//     }
//     if (password.length < 6) {
//       return res.status(400).json('Пароль должен превышать 5 символов');
//     }

//     const hashedPassword = await bcrypt.hash(password, 10);
//     const newUser = new User({
//       username: username,
//       password: hashedPassword,
//     });

//     await newUser.save();

//     res.status(201).json('Пользователь успешно зарегистрирован');

//   } catch (error) {
//     console.error(error);
//     res.status(500).json('Ошибка сервера')
//   }
// });

// app.post('/sign-in', async (req, res) => {
//   try {
//     const username = req.body.username;
//     const password = req.body.password;

//     const existingUser = await User.findOne({username});
//     if (!existingUser) {
//       return res.status(400).json('Пользователя с таким именем не существует');
//     }

//     const checkPassword = await bcrypt.compare(password, existingUser.password)

//     if(!checkPassword){
//       return res.status(400).json('Не верный пароль');
//     }

//     res.status(201).json('Вы успешно авторизовались');

//   } catch (error) {
//     console.error(error);
//     res.status(500).json('Ошибка сервера')
//   }
// });


// async function start () {
//   try {
//       await mongoose.connect(config.get('mongoUri'))
//       server.listen(port, () => console.log(`listening on *:${port}`))
//   }catch (e) {
//       console.log('sth wrong',e.message)
//       process.exit(1)
//   }
// }

// start()