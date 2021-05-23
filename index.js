import pg from 'pg';


import randomSeed from 'random-seed';
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import csvWriter from 'csv-writer';
import path from 'path';
import fs from 'fs';
import slugify from 'slugify';

const __dirname = path.resolve();
const reportsDir = path.join(__dirname, 'reports')
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir);
}


const ITEMS = 100000;
const REPORT_EVERY_N_TIMES = 4000;
const SELECT_MEASURES = 3000; // to minimize different results we will measure average
const NAME_FIELD_VALUE_LENGTH = 10;
const SHORT_NAME_FIELD_LENGTH = 1;

const TABLE_NAME = 'names';
const RAND_SEED = 'BASE';

// initialize database connector
const { Pool } = pg;
const pool = new Pool({
  user: 'researcher',
  host: 'localhost',
  database: 'testdb',
  password: 'passw1',
  port: 5432,
});


const app = express();
app.get('/', async (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'));
})


const server = http.createServer(app);


const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on('connection', (ws) => {
  connections.push(ws)
  //connection is up, let's add a simple simple event
  // ws.on('message', (message) => {

  //     //log the received message and send it back to the client
  //     console.log('received: %s', message);
  //     ws.send(`Hello, you sent -> ${message}`);
  // });

  // send old data
  for (const chartName of Object.keys(csv_records_by_exp)) {
    for (const dataPoint of csv_records_by_exp[chartName]) {
      ws.send(JSON.stringify({
        type: 'add_data',
        chartName,
        dataPoint,
      }))
    }

  }
});


server.listen(8889, '127.0.0.1', async () => {
  console.log(`Server started on port http://127.0.0.1:${server.address().port}`);
 // await sleep(2 * 1e3)
  runner()
});




const connections = [];

// random string generator
function gen_random_string(length, seeder) {
  const result = [];
  const alphabet = 'AB';
  for ( let i = 0; i < length; i++ ) {
    result.push(alphabet.charAt(seeder(alphabet.length)));
 }
 return result.join('');
}

function gen_unique_string(length) {
 return Array('-').join('');  // we will never use minuses in Alphabet so this strig which could not be found
}
 
const csv_records_by_exp = {};

let res;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


const runner = async () => {

  const runexp = async (chartName, insertQuery, selectQuery) => {

    // CSV Generator Initialization
    const createCsvWriter = csvWriter.createObjectCsvWriter;
    const csvWrtr = createCsvWriter({
      append: false,
      path: `${reportsDir}/${slugify(chartName, { remove: '"' })}.csv`,
      header: [
          {id: 'count', title: 'Count of items'},
          {id: 'select_time', title: 'Select time (ms)'},
          {id: 'insert_time', title: 'Insert time (ms)'},
      ]
    });

    for (let i = 0; i < ITEMS; i += REPORT_EVERY_N_TIMES) {
      
      let avg_time = 0;
      for (let j = 1; j <= REPORT_EVERY_N_TIMES; j++) {
        res = await pool.query(`EXPLAIN ANALYSE ${insertQuery.text}`, insertQuery.dataGenerator(i + j))
        avg_time += +res.rows[res.rows.length - 1]['QUERY PLAN'].replace('Execution Time: ', '').replace(' ms', '')
      }
      const insert_time = avg_time * 1.0 / REPORT_EVERY_N_TIMES;

      avg_time = 0;
      
      for (let j = 1; j <= SELECT_MEASURES; j++) {
        res = await pool.query(`EXPLAIN ANALYSE ${selectQuery.text}`, selectQuery.dataGenerator(i + j));
        avg_time += +res.rows[res.rows.length - 1]['QUERY PLAN'].replace('Execution Time: ', '').replace(' ms', '')
      }
      const select_time = avg_time / SELECT_MEASURES;
      
      if (!csv_records_by_exp[chartName]) {
        csv_records_by_exp[chartName] = [];
      }
      const dataPoint = {
        count: i + 1 * REPORT_EVERY_N_TIMES,
        insert_time: insert_time,
        select_time: select_time,
      };

      csv_records_by_exp[chartName].push(dataPoint);
      for (const conn of connections) {
        conn.send(JSON.stringify({
          type: 'add_data',
          chartName,
          dataPoint,
        }));
      }
      console.log(`Items in the table ${i + 1 * REPORT_EVERY_N_TIMES} / ${ITEMS}`);
    }
    
    await csvWrtr.writeRecords(csv_records_by_exp[chartName]);
    console.log(`CSV file "${chartName}.csv" ...Done`);
  }

  let seeder;
  let search_word;
  try {
    await pool.query(`DROP TABLE ${TABLE_NAME};`,);
  } catch {}


  // 🧪  EXP 1 
  seeder = randomSeed.create(RAND_SEED);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50) );`,);
  


  // word against we will search, let it make 100% non existing to make sure we are at the worst case
  search_word = gen_unique_string(NAME_FIELD_VALUE_LENGTH);

  await runexp(
    'Select by "name" without Index on "name"', 
    {
      text: `INSERT INTO ${TABLE_NAME} (name) VALUES ($1);`,
      dataGenerator: (i) => [gen_random_string(NAME_FIELD_VALUE_LENGTH, seeder)],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 2
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_unique_string(NAME_FIELD_VALUE_LENGTH);

  // cleanup all table before new experiment
  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50) );`,);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name);`,);
  await runexp(
    'Select by "name" with index on "name"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name) VALUES ($1);`,
      dataGenerator: (i) => [gen_random_string(NAME_FIELD_VALUE_LENGTH, seeder)],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 3
  seeder = randomSeed.create(RAND_SEED);

  // this will 100% to be found because of short len match so we can unleash next level search by age
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  // cleanup all table before new experiment
  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name);`);
    
  await runexp(
    'Search on "name", "age" with index on "name" only',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 and age = $2;`,
      dataGenerator: (i) => [search_word, 1],
    }
  );

  // 🧪 EXP 4
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);


  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`,);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age);`,);

  await runexp(
    'Search on "name", "age" with index on "name", "age"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 and age = $2;`,
      dataGenerator: (i) => [search_word, 1],
    }
  );
  // 🧪 EXP 5
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_unique_string(NAME_FIELD_VALUE_LENGTH);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`,);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age);`,);

  await runexp(
    'Search on "name" with index on "name", "age"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(NAME_FIELD_VALUE_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 6
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_unique_string(NAME_FIELD_VALUE_LENGTH);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`,);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (age, name);`,);

  await runexp(
    'Search on "name" with index on "age", "name"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(NAME_FIELD_VALUE_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 7
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_unique_string(NAME_FIELD_VALUE_LENGTH);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`,);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (age, name);`,);
  await pool.query(`CREATE INDEX index2 ON ${TABLE_NAME} (name);`,);

  await runexp(
    'Search on "name" with index on "age", "name" + index on "name"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(NAME_FIELD_VALUE_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1;`,
      dataGenerator: (i) => [search_word],
    }
  );



  // 🧪 EXP 8
  seeder = randomSeed.create(RAND_SEED);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name);`);
  
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await runexp(
    'Search top 1 with exact "name" ordered by "age" (oldest) descending with index on "name" only',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), 10 + seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age DESC LIMIT 1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 9
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age desc);`);

  await runexp(
    'Search top 1 with exact "name" ordered by "age" descending (oldest) with index on "name", "age desc"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age desc LIMIT 1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 10
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age desc);`);

  await runexp(
    'Search all with exact "name" ordered by "age" descending with index on "name", "age desc"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), seeder(100) ],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age desc;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 11
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age desc);`);

  await runexp(
    'Search top 1 with exact "name" ordered by "age" ascending (youngest) with index on "name", "age desc"',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age) VALUES ($1, $2);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), seeder(100)],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age asc LIMIT 1;`,
      dataGenerator: (i) => [search_word],
    }
  );
  

  // 🧪 EXP 12
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER, deposit INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age desc, deposit desc);`);

  await runexp(
    'Search on "name" items ordered by "age" ascending, "deposit", descending with index on "name", "age desc", "deposit desc" ',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age, deposit) VALUES ($1, $2, $3);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), seeder(100), seeder(200)],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age asc, deposit desc LIMIT 1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  // 🧪 EXP 13
  seeder = randomSeed.create(RAND_SEED);
  search_word = gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder);

  await pool.query(`DROP TABLE ${TABLE_NAME};`);
  await pool.query(`CREATE TABLE ${TABLE_NAME} ( id serial PRIMARY KEY,	name VARCHAR (50), age INTEGER, deposit INTEGER );`);
  await pool.query(`CREATE INDEX index1 ON ${TABLE_NAME} (name, age, deposit desc);`);

  await runexp(
    'Search top 1 with exact "name" ordered by "age" ascending, "deposit", descending with index on "name", "age asc", "deposit desc" ',
    {
      text: `INSERT INTO ${TABLE_NAME} (name, age, deposit) VALUES ($1, $2, $3);`,
      dataGenerator: (i) => [gen_random_string(SHORT_NAME_FIELD_LENGTH, seeder), seeder(100), seeder(200)],
    },
    {
      text: `SELECT FROM ${TABLE_NAME} WHERE name = $1 ORDER BY age asc, deposit desc LIMIT 1;`,
      dataGenerator: (i) => [search_word],
    }
  );

  await pool.end();
};




