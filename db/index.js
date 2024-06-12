const { Client } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { response } = require("express");

const client = new Client({
  connectionString:
    process.env.DATABASE_URL || "postgres://localhost/juicebox-dev",
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

const JWT_SECRET = "secret";

async function createUser({ username, password, name, location }) {
  const hashPassword = await bcrypt.hash(password, 5);

  try {
    const response = await client.query(
      `
          INSERT INTO users(username, password, name, location) 
          VALUES($1, $2, $3, $4) 
          ON CONFLICT (username) DO NOTHING 
          RETURNING *
        `,
      [username, hashPassword, name, location]
    );
    return response.rows[0];
  } catch (error) {
    throw error;
  }
}

const createUserAndGenerateToken = async ({
  username,
  password,
  name,
  location,
}) => {
  const user = await createUser({ username, password, name, location });
  const token = await jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET
  );
  console.log("This is the token: ", token);
  return {
    user,
    token,
  };
};

async function updateUser(id, fields = {}) {

  const setString = Object.keys(fields)
    .map((key, index) => `"${key}"=$${index + 1}`)
    .join(", ");

  if (setString.length === 0) {
    return;
  }
  try {
    const {
      rows: [user],
    } = await client.query(
      `
      UPDATE users
      SET ${setString}
      WHERE id=${id}
      RETURNING *;
    `,
      Object.values(fields)
    );

    return user;
  } catch (error) {
    throw error;
  }
}

async function getAllUsers() {
  try {
    const { rows } = await client.query(`
      SELECT id, username, name, location, active 
      FROM users;
    `);

    return rows;
  } catch (error) {
    throw error;
  }
}

async function getUserById(userId) {
  try {
    const {
      rows: [user],
    } = await client.query(`
      SELECT id, username, name, location, active
      FROM users
      WHERE id=${userId}
    `);

    if (!user) {
      throw {
        name: "UserNotFoundError",
        message: "A user with that id does not exist",
      };
    }

    user.posts = await getPostsByUser(userId);

    return user;
  } catch (error) {
    throw error;
  }
}

async function authenticateLogin({ username, password }) {
  const response = await client.query(
    `SELECT *
      FROM users
      WHERE username=$1
    `,
    [username]
  );

  if (
    !response.rows.length ||
    (await bcrypt.compare(password, response.rows[0].password)) === false
  ) {
    throw {
      name: "UserNotFoundError",
      message: "A user with that username does not exist",
    };
  }

  const token = await jwt.sign({ id: response.rows[0].id }, JWT_SECRET);

  return {
    user: response.rows[0],
    token,
  };
}

const findUserWithToken = async (token) => {
  let id;
  try {
    const payload = await jwt.verify(token, JWT_SECRET);
    id = payload.id;
  } catch (ex) {
    const error = Error("not an authorized user");
    error.status = 401;
    throw error;
  }
  const response = await client.query(
    `SELECT id, username FROM users WHERE id=$1`,
    [id]
  );
  if (!response.rows.length) {
    const error = Error("user not authorized");
    error.status = 401;
    throw error;
  }
  return response.rows[0];
};

async function createPost({ authorId, title, content, tags = [] }) {
  try {
    const response = await client.query(
      `INSERT INTO posts("authorId", title, content) 
      VALUES($1, $2, $3)
      RETURNING *`,
      [authorId, title, content]
    );

    const tagList = await createTags(tags);

    addTagsToPost(response.rows[0].id, tagList);

    return {
      post: response.rows[0],
      tags,
    };
  } catch (error) {
    console.error(error);
  }
}

async function updatePost(postId, fields = {}) {
  const { tags } = fields;
  delete fields.tags;

  const setString = Object.keys(fields)
    .map((key, index) => `"${key}"=$${index + 1}`)
    .join(", ");

  try {
    if (setString.length > 0) {
      await client.query(
        `
        UPDATE posts
        SET ${setString}
        WHERE id=${postId}
        RETURNING *;
      `,
        Object.values(fields)
      );
    }

    if (tags === undefined) {
      return await getPostById(postId);
    }

    const tagList = await createTags(tags);
    const tagListIdString = tagList.map((tag) => `${tag.id}`).join(", ");

    await client.query(
      `
      DELETE FROM post_tags
      WHERE "tagId"
      NOT IN (${tagListIdString})
      AND "postId"=$1;
    `,
      [postId]
    );

    await addTagsToPost(postId, tagList);

    return await getPostById(postId);
  } catch (error) {
    throw error;
  }
}

async function getAllPosts() {
  try {
    const { rows: postIds } = await client.query(`
      SELECT id
      FROM posts;
    `);

    const posts = await Promise.all(
      postIds.map((post) => getPostById(post.id))
    );

    return posts;
  } catch (error) {
    throw error;
  }
}

async function getPostById(postId) {
  try {
    const {
      rows: [post],
    } = await client.query(
      `
      SELECT *
      FROM posts
      WHERE id=$1;
    `,
      [postId]
    );

    if (!post) {
      throw {
        name: "PostNotFoundError",
        message: "Could not find a post with that postId",
      };
    }

    const { rows: tags } = await client.query(
      `
      SELECT tags.*
      FROM tags
      JOIN post_tags ON tags.id=post_tags."tagId"
      WHERE post_tags."postId"=$1;
    `,
      [postId]
    );

    const {
      rows: [author],
    } = await client.query(
      `
      SELECT id, username, name, location
      FROM users
      WHERE id=$1;
    `,
      [post.authorId]
    );

    post.tags = tags;
    post.author = author;

    delete post.authorId;

    return post;
  } catch (error) {
    throw error;
  }
}

async function getPostsByUser(userId) {
  try {
    const { rows: postIds } = await client.query(`
      SELECT id 
      FROM posts 
      WHERE "authorId"=${userId};
    `);

    const posts = await Promise.all(
      postIds.map((post) => getPostById(post.id))
    );

    return posts;
  } catch (error) {
    throw error;
  }
}

async function getPostsByTagName(tagName) {
  try {
    const { rows: postIds } = await client.query(
      `
      SELECT posts.id
      FROM posts
      JOIN post_tags ON posts.id=post_tags."postId"
      JOIN tags ON tags.id=post_tags."tagId"
      WHERE tags.name=$1;
    `,
      [tagName]
    );

    return await Promise.all(postIds.map((post) => getPostById(post.id)));
  } catch (error) {
    throw error;
  }
}

async function deletePost(id) {
  await client.query(`DELETE FROM post_tags WHERE "postId"=$1`, [id]);
  await client.query(`DELETE FROM posts WHERE id=$1`, [id]);

  return {
    id: id,
  };
}

async function createTags(tagList) {
  if (tagList.length === 0) {
    return;
  }

  const valuesStringInsert = tagList
    .map((_, index) => `$${index + 1}`)
    .join("), (");

  const valuesStringSelect = tagList
    .map((_, index) => `$${index + 1}`)
    .join(", ");

  try {
    await client.query(
      `
      INSERT INTO tags(name)
      VALUES (${valuesStringInsert})
      ON CONFLICT (name) DO NOTHING;
    `,
      tagList
    );

    const { rows } = await client.query(
      `
      SELECT * FROM tags
      WHERE name
      IN (${valuesStringSelect});
    `,
      tagList
    );

    return rows;
  } catch (error) {
    throw error;
  }
}

async function createPostTag(postId, tagId) {
  try {
    await client.query(
      `
      INSERT INTO post_tags("postId", "tagId")
      VALUES ($1, $2)
      ON CONFLICT ("postId", "tagId") DO NOTHING;
    `,
      [postId, tagId]
    );
  } catch (error) {
    throw error;
  }
}

async function addTagsToPost(postId, tagList) {
  try {
    const createPostTagPromises = tagList.map((tag) =>
      createPostTag(postId, tag.id)
    );
    await Promise.all(createPostTagPromises);
    return await getPostById(postId);
  } catch (error) {
    throw error;
  }
}

async function getAllTags() {
  try {
    const { rows } = await client.query(`
      SELECT * 
      FROM tags;
    `);

    return { rows };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  client,
  createUser,
  updateUser,
  getAllUsers,
  getUserById,
  authenticateLogin,
  getPostById,
  createPost,
  updatePost,
  getAllPosts,
  getPostsByUser,
  getPostsByTagName,
  createTags,
  getAllTags,
  createPostTag,
  addTagsToPost,
  findUserWithToken,
  createUserAndGenerateToken,
  deletePost,
};