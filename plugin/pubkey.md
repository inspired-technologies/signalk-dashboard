# Setting up public key authentication

Key based authentication in SSH is called public key authentication. The purpose of ssh-copy-id is to make setting up public key authentication easier. The process is as follows.

## Generate an SSH Key

Creating a key pair (public key and private key) only takes a minute. The key files are usually stored in the ~/.ssh directory.

With OpenSSH, an SSH key is created using ssh-keygen. In the simplest form, just run ssh-keygen and answer the questions. 
```
# ssh-keygen 
Generating public/private rsa key pair. 
Enter file in which to save the key (/home/pi/.ssh/id_rsa): mykey 
Enter passphrase (empty for no passphrase):  
Enter same passphrase again:  
Your identification has been saved in mykey. 
Your public key has been saved in mykey.pub. 
The key fingerprint is: SHA256:GKW7....z3Us pi@host 

The key's randomart image is: 
+---[RSA 3072]----+
|        o=+o..   |
|        .o..=    |
|        oE.+ .   |
|    .  . o+ .    |
|   . o.oSo .     |
|  . + +.*o.      |
|.o o +.B+.       |
|= = o.B.o        |
|+*o*+=.o         |
+----[SHA256]-----+

```

## Copy the key to a server

Once an SSH key has been created, the ssh-copy-id command can be used to install it as an authorized key on the server. Once the key has been authorized for SSH, it grants access to the server without a password.

Use a command like the following to copy SSH key:

```
ssh-copy-id -i ~/.ssh/mykey pi@remote
```
This logs into the server host, and copies keys to the server, and configures them to grant access by adding them to the authorized_keys file. The copying may ask for a password or other authentication for the server.

Only the public key is copied to the server. The private key should never be copied to another machine.

## Test the new key

Once the key has been copied, it is best to test it:
```
ssh user@host
```
The login should now complete without asking for a password. Note, however, that the command might ask for the passphrase you specified for the key.
