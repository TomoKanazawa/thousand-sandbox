create table patient (id integer primary key, first text not null, last text not null, dob text not null, phone text not null, signed integer not null default 0);
create table note (id integer primary key autoincrement, patient integer not null references patient(id), text text not null, author text not null);
