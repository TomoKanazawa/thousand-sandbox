-- State at the start of the capture.
insert into patient (id, first, last, dob, phone) values
  (101, 'Ada', 'Marlow', '1961-03-14', '555-0101'),
  (102, 'Ben', 'Okafor', '1978-11-02', '555-0102'),
  (103, 'Cleo', 'Tanaka', '1990-07-23', '555-0103'),
  (104, 'Dev', 'Rossi', '1955-01-30', '555-0104');
insert into note (id, patient, text, author) values
  (1, 101, 'Follow-up in two weeks.', 'dr.test'),
  (2, 101, 'Blood pressure stable.', 'dr.test'),
  (3, 102, 'New patient intake.', 'dr.test'),
  (4, 103, 'Refill requested.', 'dr.test');
