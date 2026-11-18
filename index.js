import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

// root api
app.get('/', (req, res) => {
    res.send('WedPlan is planning!');
})

app.listen(port, () => {
    console.log(`WedPlan is running on port ${port}`)
})

export default app;
